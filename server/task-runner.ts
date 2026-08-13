import fs from "node:fs";
import path from "node:path";
import { configDir, type GemaLocalConfig } from "./config.js";
import {
  brokerGet,
  type ClaimedTask,
  completeTask,
} from "./gema/client.js";
import { buildGemaTools } from "./gema/tools.js";
import { runAgentRuntime } from "./runtimes/index.js";

/** Hard local watchdog — the server's own watchdog fails tasks at 20 min,
 * so give up (and report honestly) before it has to. */
const TASK_DEADLINE_MS = 15 * 60 * 1000;
/** Mirror of the container runner's TRACE_CAP. */
const TRACE_CAP = 20;

/**
 * The companion's system prompt — adapted from the container runner's
 * (apps/server/gemaclaw/runner-core.ts systemPrompt) for native
 * tool-calling instead of the JSON-action REPL. Same identity, same
 * guardrails, same grounding rules.
 */
export function systemPrompt(prompt: string, context: unknown): string {
  const skills = contextSkills(context);
  return [
    "You are Gema, a warm household grocery assistant taking your time on a task the household asked you to think through.",
    "Speak as Gema in the first person — calm, concise, never mention being a sandbox, model, or agent.",
    "Use the gema tools for everything you read and everything you do. Read before you act when the context is not enough — but do not re-read what you already have.",
    "You cannot delete anything, change expenses, or write the list directly; members approve every proposal.",
    "Ground everything in the real household data. Never invent list contents. Never use developer jargon or emoji.",
    "Post at most 1-2 chat messages. When everything is finished, call the done tool with a one-line, friendly wrap-up.",
    "",
    `TASK: ${prompt}`,
    "",
    "HOUSEHOLD CONTEXT:",
    JSON.stringify(context ?? {}),
    ...(skills.length > 0
      ? [
          "",
          "Savoir-faire disponibles :",
          ...skills.map(
            (skill) =>
              `- ${promptLine(skill.name)} : ${promptLine(skill.description).slice(0, 200)}`,
          ),
          "Avant une tâche similaire, appelle read_skill avec le nom pour relire la méthode avant d'agir.",
        ]
      : []),
  ].join("\n");
}

const promptLine = (s: string) => s.replace(/\s+/g, " ").trim();

function contextSkills(
  context: unknown,
): Array<{ name: string; description: string }> {
  if (typeof context !== "object" || context === null) return [];
  const raw = (context as { skills?: unknown }).skills;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (entry): entry is { name: string; description?: unknown } =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === "string",
    )
    .map((entry) => ({
      name: entry.name,
      description: String(entry.description ?? ""),
    }));
}

export interface TaskRunnerDeps {
  runRuntime?: typeof runAgentRuntime;
  /** Structured per-task log sink (JSONL on disk by default). */
  log?: (event: Record<string, unknown>) => void;
}

function fileLogger(actionId: string): (event: Record<string, unknown>) => void {
  const dir = path.join(configDir(), "logs");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return () => {};
  }
  const file = path.join(dir, `${actionId}.jsonl`);
  return (event) => {
    try {
      fs.appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
    } catch {
      // Logging must never take the task down.
    }
  };
}

/**
 * Run one claimed task end-to-end on the configured subscription runtime.
 * Always reports completion to the broker — success with the model's
 * wrap-up, or an honest failure on error/timeout/silence.
 */
export async function runClaimedTask(
  config: GemaLocalConfig,
  task: ClaimedTask,
  deps: TaskRunnerDeps = {},
): Promise<void> {
  const runRuntime = deps.runRuntime ?? runAgentRuntime;
  const log = deps.log ?? fileLogger(task.actionId);
  let done: { summary: string; ok: boolean } | null = null;
  const trace: Array<{ action: string; note: string }> = [];

  const tools = buildGemaTools(task, {
    onDone: (summary, ok) => {
      done = { summary, ok };
    },
    onTrace: (action, note) => {
      if (trace.length < TRACE_CAP) trace.push({ action, note });
    },
  });

  const abortController = new AbortController();
  const watchdog = setTimeout(() => abortController.abort(), TASK_DEADLINE_MS);

  try {
    const { prompt, context } = await brokerGet<{
      prompt?: string;
      context?: unknown;
    }>(task, "/context");

    log({ event: "start", prompt: prompt ?? task.prompt });

    const result = await runRuntime(config, {
      prompt:
        "Begin the task now. Use the gema tools, then call done with your wrap-up.",
      systemPrompt: systemPrompt(prompt ?? task.prompt, context),
      tools,
      mode: "execution",
      abortController,
      allowedTools: [
        ...tools.map((tool) => `mcp__gema__${tool.name}`),
        "WebSearch",
        "WebFetch",
      ],
      disallowedTools: [
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "NotebookEdit",
        "Task",
        "Skill",
      ],
      onToolUse: (toolName, input) => {
        log({ event: "tool", toolName, input });
      },
      onText: (text) => {
        log({ event: "text", text });
      },
    });

    if (!done && result.text.trim()) {
      // Text-only finishes are normal for chat-tuned models: treat the
      // final reply as the wrap-up rather than failing an honest run.
      done = { summary: result.text.trim().slice(0, 1000), ok: true };
    }
    const finished = done ?? {
      summary: "The companion finished without reporting a result.",
      ok: false,
    };
    log({ event: "complete", ...finished });
    await completeTask(task, finished.summary, finished.ok, trace);
  } catch (err) {
    log({ event: "error", error: String(err) });
    const summary = abortController.signal.aborted
      ? "This took longer than I allow myself locally — I stopped partway. Anything I already posted in chat still stands."
      : "Something went wrong on the household computer while I worked on this.";
    await completeTask(task, done?.summary ?? summary, false, trace);
  } finally {
    clearTimeout(watchdog);
  }
}
