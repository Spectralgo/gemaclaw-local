import { z } from "zod";
import { defineRuntimeTool } from "../runtimes/tool.js";
import type { RuntimeTool } from "../runtimes/types.js";
import { brokerGet, brokerPost, type ClaimedTask } from "./client.js";

/**
 * Gema's sandbox tool surface as native runtime tools — the same eleven
 * capabilities the hosted container gets, backed by the same lease-gated
 * broker. The descriptions deliberately mirror the container contract
 * (apps/server/gemaclaw/runner-core.ts SANDBOX_TOOLS): broad reads,
 * narrow approval-gated writes, no deletes, no direct list writes.
 *
 * Broker failures surface as tool-result text (never thrown) so the model
 * can react — a dead lease reads as an instruction to wrap up.
 */

/** Mirror of the container's TOOL_RESULT_CHARS cap. */
const TOOL_RESULT_CHARS = 6000;

export interface GemaToolHooks {
  /** The model called `done` — record the wrap-up for /complete. */
  onDone: (summary: string, ok: boolean) => void;
  /** Every successful tool call, for the completion trace. */
  onTrace?: (action: string, note: string) => void;
}

function clip(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > TOOL_RESULT_CHARS
    ? `${text.slice(0, TOOL_RESULT_CHARS)}…`
    : text;
}

export function buildGemaTools(
  task: ClaimedTask,
  hooks: GemaToolHooks,
): RuntimeTool[] {
  const trace = (action: string, note: string) =>
    hooks.onTrace?.(action, note.slice(0, 200));

  function readTool(name: string, path: string, description: string) {
    return defineRuntimeTool("gema", name, description, {}, async () => {
      try {
        const result = await brokerGet<unknown>(task, path);
        trace(name, "ok");
        return { text: clip(result), success: true };
      } catch (err) {
        return { text: `The read failed: ${String(err)}`, success: false };
      }
    });
  }

  return [
    readTool(
      "read_list",
      "/list",
      "Read the full shopping list: item ids, names, quantity, store, done state.",
    ),
    readTool(
      "read_expenses",
      "/expenses",
      "Read recent household expenses: description, amount in cents, who paid, category, date.",
    ),
    readTool("read_chat", "/chat", "Read the recent household chat messages."),
    readTool(
      "read_members",
      "/members",
      "Read household member first names and roles.",
    ),
    readTool(
      "read_notebook",
      "/notebook",
      "Read your saved notebook notes about this household.",
    ),
    defineRuntimeTool(
      "gema",
      "read_skill",
      "Load one household skill (savoir-faire) by name before doing a similar task. Names come from the skills index in your context.",
      { name: z.string() },
      async ({ name }) => {
        try {
          const result = await brokerGet<unknown>(
            task,
            `/skill/${encodeURIComponent(name)}`,
          );
          trace("read_skill", name);
          return { text: clip(result), success: true };
        } catch (err) {
          return { text: `The read failed: ${String(err)}`, success: false };
        }
      },
    ),
    defineRuntimeTool(
      "gema",
      "post_message",
      "Say something useful in the household chat (plans, findings). Warm and brief; at most 1-2 messages per task.",
      { text: z.string() },
      async ({ text }) => {
        try {
          await brokerPost(task, "/message", { text });
          trace("post_message", text);
          return { text: "Message posted to the household chat.", success: true };
        } catch (err) {
          return { text: `Posting failed: ${String(err)}`, success: false };
        }
      },
    ),
    defineRuntimeTool(
      "gema",
      "remember",
      "Save ONE durable household fact (preferences, routines) to your notebook. Use sparingly.",
      { note: z.string() },
      async ({ note }) => {
        try {
          await brokerPost(task, "/memory", { note });
          trace("remember", note);
          return { text: "Noted in your notebook.", success: true };
        } catch (err) {
          return { text: `Remembering failed: ${String(err)}`, success: false };
        }
      },
    ),
    defineRuntimeTool(
      "gema",
      "propose_items",
      "Suggest groceries to ADD to the list; a member must approve them — you cannot write the list directly.",
      {
        items: z.array(
          z.object({ name: z.string(), location: z.string().optional() }),
        ),
      },
      async ({ items }) => {
        try {
          const result = await brokerPost<{ actionId?: string | null }>(
            task,
            "/propose",
            {
              kind: "add_items",
              items: items.map((item) => ({
                name: item.name,
                location: item.location ?? "",
              })),
            },
          );
          trace("propose_items", items.map((i) => i.name).join(", "));
          return {
            text: result.actionId
              ? "Suggestion sent — a member will see an approval card in chat."
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
      "Suggest ticking items OFF the list (use ids from read_list); a member must approve.",
      { items: z.array(z.object({ id: z.string(), name: z.string() })) },
      async ({ items }) => {
        try {
          const result = await brokerPost<{ actionId?: string | null }>(
            task,
            "/propose",
            { kind: "complete_items", items },
          );
          trace("complete_items", items.map((i) => i.name).join(", "));
          return {
            text: result.actionId
              ? "Suggestion sent — a member will see an approval card in chat."
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
      "done",
      "Finish the task with a one-line, friendly wrap-up. Call this exactly once, when everything is finished.",
      { summary: z.string(), ok: z.boolean().optional() },
      async ({ summary, ok }) => {
        hooks.onDone(summary, ok !== false);
        return {
          text: "Wrap-up recorded — the task is finished, stop here.",
          success: true,
        };
      },
    ),
  ];
}
