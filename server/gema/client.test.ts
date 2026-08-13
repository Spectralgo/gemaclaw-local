import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GemaLocalConfig } from "../config.js";
import {
  claimTask,
  CompanionAuthError,
  completeTask,
  brokerGet,
  pair,
  pollTasks,
} from "./client.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";

let server: FakeServer;
let config: GemaLocalConfig;

beforeEach(async () => {
  server = await startFakeServer();
  config = {
    serverUrl: server.url,
    companionToken: "tok-companion",
    runtime: "claude",
  };
});

afterEach(async () => {
  await server.close();
});

describe("pair", () => {
  it("exchanges a code for the token", async () => {
    server.respond("POST", "/gemaclaw/companion/pair", 200, { token: "tok-1" });
    await expect(pair(server.url, "ABCD2345", "My Mac")).resolves.toBe("tok-1");
    expect(server.requests[0]?.body).toEqual({
      code: "ABCD2345",
      deviceName: "My Mac",
    });
  });

  it("explains a 404 (flag off / wrong URL) and a 403 (bad code)", async () => {
    server.respond("POST", "/gemaclaw/companion/pair", 404, {
      error: "not found",
    });
    await expect(pair(server.url, "X", "Mac")).rejects.toThrow(/not have/);
    server.respond("POST", "/gemaclaw/companion/pair", 403, {
      error: "Forbidden",
    });
    await expect(pair(server.url, "X", "Mac")).rejects.toThrow(/expired/);
  });
});

describe("pollTasks", () => {
  it("returns the pending tasks and sends the token", async () => {
    server.respond("POST", "/gemaclaw/companion/poll", 200, {
      tasks: [{ actionId: "task-1", prompt: "plan meals" }],
    });
    await expect(pollTasks(config)).resolves.toEqual([
      { actionId: "task-1", prompt: "plan meals" },
    ]);
    expect(server.requests[0]?.body).toEqual({ token: "tok-companion" });
  });

  it("raises CompanionAuthError on 403 so the poller can stop", async () => {
    server.respond("POST", "/gemaclaw/companion/poll", 403, {
      error: "Forbidden",
    });
    await expect(pollTasks(config)).rejects.toBeInstanceOf(CompanionAuthError);
  });
});

describe("claimTask", () => {
  it("returns the lease on a win, falling back to serverUrl for the broker", async () => {
    server.respond("POST", "/gemaclaw/companion/claim", 200, {
      actionId: "task-1",
      prompt: "plan meals",
      leaseToken: "lease-1",
      brokerUrl: "",
    });
    await expect(claimTask(config, "task-1")).resolves.toEqual({
      actionId: "task-1",
      prompt: "plan meals",
      leaseToken: "lease-1",
      brokerUrl: server.url,
    });
  });

  it("returns null when another runner won (409)", async () => {
    server.respond("POST", "/gemaclaw/companion/claim", 409, {
      error: "already claimed",
    });
    await expect(claimTask(config, "task-1")).resolves.toBeNull();
  });
});

describe("broker calls", () => {
  const task = () => ({
    actionId: "task-1",
    prompt: "plan meals",
    leaseToken: "lease-1",
    brokerUrl: server.url,
  });

  it("sends the lease header on reads", async () => {
    server.respond("GET", "/gemaclaw/task-1/list", 200, { items: [] });
    await expect(brokerGet(task(), "/list")).resolves.toEqual({ items: [] });
    expect(server.requests[0]?.headers["x-gemaclaw-lease"]).toBe("lease-1");
  });

  it("completeTask posts the wrap-up and never throws on a dead lease", async () => {
    server.respond("POST", "/gemaclaw/task-1/complete", 200, { ok: true });
    await expect(completeTask(task(), "all done", true)).resolves.toBe(true);
    expect(server.requests[0]?.body).toEqual({
      summary: "all done",
      ok: true,
      trace: undefined,
    });
    server.respond("POST", "/gemaclaw/task-1/complete", 403, {
      error: "Forbidden",
    });
    await expect(completeTask(task(), "late", false)).resolves.toBe(false);
  });
});
