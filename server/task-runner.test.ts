import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GemaLocalConfig } from "./config.js";
import type { ClaimedTask } from "./gema/client.js";
import { startFakeServer, type FakeServer } from "./gema/fake-server.js";
import type { runAgentRuntime } from "./runtimes/index.js";
import { runClaimedTask, systemPrompt } from "./task-runner.js";

let server: FakeServer;
let task: ClaimedTask;
const config: GemaLocalConfig = {
  serverUrl: "http://unused",
  companionToken: "tok",
  runtime: "claude",
};

beforeEach(async () => {
  server = await startFakeServer();
  task = {
    actionId: "task-1",
    prompt: "plan meals",
    leaseToken: "lease-1",
    brokerUrl: server.url,
  };
  server.respond("GET", "/gemaclaw/task-1/context", 200, {
    prompt: "plan three dinners",
    context: { list: [], skills: [{ name: "plats", description: "soirs" }] },
  });
  server.respond("POST", "/gemaclaw/task-1/complete", 200, { ok: true });
});

afterEach(async () => {
  await server.close();
});

const completeBody = () =>
  server.requests.find((r) => r.path.endsWith("/complete"))?.body as {
    summary: string;
    ok: boolean;
    trace?: unknown[];
  };

function fakeRuntime(
  impl: (request: Parameters<typeof runAgentRuntime>[1]) => Promise<string>,
) {
  return vi.fn(async (_config: unknown, request: never) => ({
    text: await impl(request),
    usage: {} as never,
  })) as unknown as typeof runAgentRuntime;
}

describe("runClaimedTask", () => {
  it("feeds the broker context into the system prompt and completes with the done wrap-up", async () => {
    const runRuntime = fakeRuntime(async (request) => {
      expect(request.systemPrompt).toContain("plan three dinners");
      expect(request.systemPrompt).toContain("Savoir-faire disponibles");
      expect(request.allowedTools).toContain("mcp__gema__read_list");
      expect(request.allowedTools).toContain("WebSearch");
      expect(request.disallowedTools).toContain("Bash");
      const done = request.tools.find((t) => t.name === "done");
      await done?.handle({ summary: "Dinners planned.", ok: true });
      return "";
    });

    await runClaimedTask(config, task, { runRuntime, log: () => {} });

    expect(completeBody()).toMatchObject({ summary: "Dinners planned.", ok: true });
  });

  it("treats a text-only finish as the wrap-up", async () => {
    const runRuntime = fakeRuntime(async () => "All sorted — see chat.");
    await runClaimedTask(config, task, { runRuntime, log: () => {} });
    expect(completeBody()).toMatchObject({
      summary: "All sorted — see chat.",
      ok: true,
    });
  });

  it("reports an honest failure when the runtime returns nothing", async () => {
    const runRuntime = fakeRuntime(async () => "");
    await runClaimedTask(config, task, { runRuntime, log: () => {} });
    expect(completeBody()).toMatchObject({ ok: false });
  });

  it("reports an honest failure when the runtime throws", async () => {
    const runRuntime = fakeRuntime(async () => {
      throw new Error("SDK exploded");
    });
    await runClaimedTask(config, task, { runRuntime, log: () => {} });
    expect(completeBody()).toMatchObject({ ok: false });
  });

  it("honors a recorded done wrap-up even when the runtime throws afterwards", async () => {
    const runRuntime = fakeRuntime(async (request) => {
      const doneTool = request.tools.find((t) => t.name === "done");
      await doneTool?.handle({ summary: "All wrapped up.", ok: true });
      throw new Error("stream teardown after done");
    });
    await runClaimedTask(config, task, { runRuntime, log: () => {} });
    expect(completeBody()).toMatchObject({ summary: "All wrapped up.", ok: true });
  });

  it("includes the tool trace in the completion", async () => {
    server.respond("GET", "/gemaclaw/task-1/list", 200, { items: [] });
    const runRuntime = fakeRuntime(async (request) => {
      const read = request.tools.find((t) => t.name === "read_list");
      await read?.handle({});
      const done = request.tools.find((t) => t.name === "done");
      await done?.handle({ summary: "ok" });
      return "";
    });
    await runClaimedTask(config, task, { runRuntime, log: () => {} });
    expect(completeBody().trace).toEqual([{ action: "read_list", note: "ok" }]);
  });
});

describe("systemPrompt", () => {
  it("keeps the guardrail language and flattens skill lines", () => {
    const prompt = systemPrompt("plan", {
      skills: [{ name: "a\nb", description: "c\nd" }],
    });
    expect(prompt).toContain("members approve every proposal");
    expect(prompt).toContain("- a b : c d");
  });
});
