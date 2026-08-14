import { z } from "zod";
import type { GemaLocalConfig } from "../config.js";
import {
  fetchHouseholdContext,
  fileDeepTask,
  postHouseholdMessage,
  proposeFromChannel,
} from "../gema/client.js";
import { runAgentRuntime } from "../runtimes/index.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import type { RuntimeTool } from "../runtimes/types.js";

/** Channel asks are conversational — keep them snappier than deep tasks. */
const ASK_DEADLINE_MS = 90_000;

export interface ParsedTrigger {
  kind: "ask" | "deep";
  prompt: string;
}

/**
 * Decide whether a message is for Gema.
 * - `deep: …` (optionally after @gema) always files a deep task.
 * - With `requirePrefix` (WhatsApp — a real person's account), only
 *   `@gema …` / `gema: …` ask; everything else is silently ignored.
 * - Without it (Telegram — a dedicated bot chat), every message asks.
 */
export function parseTrigger(
  text: string,
  options: { requirePrefix: boolean },
): ParsedTrigger | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const unprefixed = trimmed.replace(/^@?gemm?a[:,]?\s+/i, "");
  const hadPrefix = unprefixed !== trimmed;
  const deep = unprefixed.match(/^deep[:,]\s*(.+)$/is);
  if (deep?.[1]) return { kind: "deep", prompt: deep[1].trim() };
  if (options.requirePrefix && !hadPrefix) return null;
  const prompt = unprefixed.trim();
  return prompt.length > 0 ? { kind: "ask", prompt } : null;
}

export const DEEP_FILED_REPLY =
  "That deserves proper thought — I've set it up as a deep task. Approve the card in the Gema app and I'll get to work on this computer.";

function askTools(
  config: GemaLocalConfig,
  used: { proposed: boolean },
): RuntimeTool[] {
  return [
    defineRuntimeTool(
      "gema",
      "read_household",
      "Read the household's live context: shopping list items, recent chat messages, and your notebook. Call this before answering anything about the household.",
      {},
      async () => {
        try {
          const context = await fetchHouseholdContext(config);
          return { text: JSON.stringify(context).slice(0, 6000), success: true };
        } catch (err) {
          return { text: `The read failed: ${String(err)}`, success: false };
        }
      },
    ),
    defineRuntimeTool(
      "gema",
      "propose_items",
      "Suggest groceries to ADD to the list; a member must approve the card in the app — you cannot write the list directly.",
      {
        items: z.array(
          z.object({ name: z.string(), location: z.string().optional() }),
        ),
      },
      async ({ items }) => {
        try {
          const result = await proposeFromChannel(config, "add_items", items);
          used.proposed = true;
          return {
            text: result.actionId
              ? "Suggestion sent — an approval card is waiting in the app."
              : "Nothing new to suggest — those items are already on the list.",
            success: true,
          };
        } catch (err) {
          return { text: `The proposal failed: ${String(err)}`, success: false };
        }
      },
    ),
    defineRuntimeTool(
      "gema",
      "complete_items",
      "Suggest ticking items OFF the list (ids from read_household); a member must approve in the app.",
      { items: z.array(z.object({ id: z.string(), name: z.string() })) },
      async ({ items }) => {
        try {
          const result = await proposeFromChannel(
            config,
            "complete_items",
            items,
          );
          used.proposed = true;
          return {
            text: result.actionId
              ? "Suggestion sent — an approval card is waiting in the app."
              : "Nothing to tick off — those items are not open on the list.",
            success: true,
          };
        } catch (err) {
          return { text: `The proposal failed: ${String(err)}`, success: false };
        }
      },
    ),
    defineRuntimeTool(
      "gema",
      "post_to_household_chat",
      "Post a short note to the household chat as Gema, visible to every member. Only when asked to tell or remind the household of something.",
      { text: z.string() },
      async ({ text }) => {
        try {
          await postHouseholdMessage(config, text);
          return { text: "Posted to the household chat.", success: true };
        } catch (err) {
          return { text: `Posting failed: ${String(err)}`, success: false };
        }
      },
    ),
  ];
}

function askSystemPrompt(): string {
  return [
    "You are Gema, a warm household grocery assistant, answering a household member over a private messenger.",
    "Speak as Gema in the first person — calm, concise, never mention being a model, agent, or companion process.",
    "Always read the household context before answering anything about the list, expenses, chat, or people. Ground everything in that real data; never invent list contents. No developer jargon, no emoji.",
    "You cannot delete anything or write the list directly — proposals become approval cards in the Gema app.",
    "This is a messenger: keep replies short (a few sentences), plain text, no markdown headings.",
    "Your final text IS the reply that will be sent back — end with it.",
  ].join("\n");
}

export interface AskRunnerDeps {
  runRuntime?: typeof runAgentRuntime;
}

/** Run one channel ask on the configured subscription runtime and return
 * the reply text. Never throws — errors become an apologetic reply. */
export async function runChannelAsk(
  config: GemaLocalConfig,
  trigger: ParsedTrigger,
  deps: AskRunnerDeps = {},
): Promise<string> {
  if (trigger.kind === "deep") {
    try {
      await fileDeepTask(config, trigger.prompt.slice(0, 500));
      return DEEP_FILED_REPLY;
    } catch (err) {
      console.error("[channels] deep task filing failed:", err);
      return "I couldn't file that deep task just now — try again in a moment.";
    }
  }

  const runRuntime = deps.runRuntime ?? runAgentRuntime;
  const used = { proposed: false };
  const tools = askTools(config, used);
  const abortController = new AbortController();
  const watchdog = setTimeout(() => abortController.abort(), ASK_DEADLINE_MS);
  try {
    const result = await runRuntime(config, {
      prompt: trigger.prompt,
      systemPrompt: askSystemPrompt(),
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
    });
    const reply = result.text.trim();
    if (reply.length > 0) return reply;
    return used.proposed
      ? "Suggestion sent — there's an approval card waiting in the app."
      : "I looked, but I don't have a useful answer for that one.";
  } catch (err) {
    console.error("[channels] ask failed:", err);
    return abortController.signal.aborted
      ? "That one took me too long — try asking a smaller piece of it."
      : "Something went wrong on my side — try again in a moment.";
  } finally {
    clearTimeout(watchdog);
  }
}
