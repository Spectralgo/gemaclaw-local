import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTool } from "../runtimes/types.js";
import { buildGemaTools, type GemaToolHooks } from "./tools.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";

let server: FakeServer;
let hooks: { onDone: ReturnType<typeof vi.fn>; onTrace: ReturnType<typeof vi.fn> };
let tools: RuntimeTool[];

const tool = (name: string): RuntimeTool => {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} missing`);
  return found;
};

beforeEach(async () => {
  server = await startFakeServer();
  hooks = { onDone: vi.fn(), onTrace: vi.fn() };
  tools = buildGemaTools(
    {
      actionId: "task-1",
      prompt: "plan meals",
      leaseToken: "lease-1",
      brokerUrl: server.url,
    },
    hooks as unknown as GemaToolHooks,
  );
});

afterEach(async () => {
  await server.close();
});

it("exposes exactly the sandbox contract: 6 reads, 4 writes, done", () => {
  expect(tools.map((t) => t.name).sort()).toEqual(
    [
      "read_list",
      "read_expenses",
      "read_chat",
      "read_members",
      "read_notebook",
      "read_skill",
      "post_message",
      "remember",
      "propose_items",
      "complete_items",
      "done",
    ].sort(),
  );
  expect(tools.every((t) => t.namespace === "gema")).toBe(true);
});

describe("reads", () => {
  it("read_list hits the broker with the lease header", async () => {
    server.respond("GET", "/gemaclaw/task-1/list", 200, {
      items: [{ id: "i1", name: "Milk" }],
    });
    const result = await tool("read_list").handle({});
    expect(result.success).toBe(true);
    expect(result.text).toContain("Milk");
    expect(server.requests[0]?.headers["x-gemaclaw-lease"]).toBe("lease-1");
  });

  it("read_skill URL-encodes the name", async () => {
    server.respond("GET", "/gemaclaw/task-1/skill/plats%20du%20soir", 200, {
      body: "method",
    });
    const result = await tool("read_skill").handle({ name: "plats du soir" });
    expect(result.success).toBe(true);
    expect(server.requests[0]?.path).toBe(
      "/gemaclaw/task-1/skill/plats%20du%20soir",
    );
  });

  it("a rejected lease surfaces as a failed tool result, not a throw", async () => {
    server.respond("GET", "/gemaclaw/task-1/list", 403, { error: "Forbidden" });
    const result = await tool("read_list").handle({});
    expect(result.success).toBe(false);
    expect(result.text).toContain("403");
  });
});

describe("writes", () => {
  it("post_message posts the text", async () => {
    server.respond("POST", "/gemaclaw/task-1/message", 200, { ok: true });
    const result = await tool("post_message").handle({ text: "Dinner sorted" });
    expect(result.success).toBe(true);
    expect(server.requests[0]?.body).toEqual({ text: "Dinner sorted" });
  });

  it("propose_items goes through the approval door with defaulted locations", async () => {
    server.respond("POST", "/gemaclaw/task-1/propose", 200, {
      ok: true,
      actionId: "card-1",
    });
    const result = await tool("propose_items").handle({
      items: [{ name: "Tofu" }, { name: "Rice", location: "Lidl" }],
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("approval card");
    expect(server.requests[0]?.body).toEqual({
      kind: "add_items",
      items: [
        { name: "Tofu", location: "" },
        { name: "Rice", location: "Lidl" },
      ],
    });
  });

  it("complete_items sends ids through the same door", async () => {
    server.respond("POST", "/gemaclaw/task-1/propose", 200, {
      ok: true,
      actionId: "card-2",
    });
    const result = await tool("complete_items").handle({
      items: [{ id: "i1", name: "Milk" }],
    });
    expect(result.success).toBe(true);
    expect(server.requests[0]?.body).toEqual({
      kind: "complete_items",
      items: [{ id: "i1", name: "Milk" }],
    });
  });

  it("a deduped proposal (null actionId) reads as nothing-to-add", async () => {
    server.respond("POST", "/gemaclaw/task-1/propose", 200, {
      ok: true,
      actionId: null,
    });
    const result = await tool("propose_items").handle({
      items: [{ name: "Milk" }],
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("already on the list");
  });
});

describe("done", () => {
  it("records the wrap-up locally without touching the broker", async () => {
    const result = await tool("done").handle({ summary: "All sorted." });
    expect(result.success).toBe(true);
    expect(hooks.onDone).toHaveBeenCalledWith("All sorted.", true);
    expect(server.requests).toHaveLength(0);
  });

  it("passes ok=false through", async () => {
    await tool("done").handle({ summary: "Could not finish.", ok: false });
    expect(hooks.onDone).toHaveBeenCalledWith("Could not finish.", false);
  });
});
