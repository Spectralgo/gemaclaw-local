import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GemaLocalConfig } from "../config.js";
import { startFakeServer, type FakeServer } from "../gema/fake-server.js";
import type { runAgentRuntime } from "../runtimes/index.js";
import {
  DEEP_FILED_REPLY,
  parseTrigger,
  runChannelAsk,
} from "./ask-runner.js";
import { ChannelRouter, formatForChannel, isAllowedSender } from "./router.js";
import {
  type ChannelMessage,
  type ChannelTransport,
  chunkText,
} from "./types.js";

const config = (over: Partial<GemaLocalConfig> = {}): GemaLocalConfig => ({
  serverUrl: "http://localhost:9",
  companionToken: "tok",
  runtime: "claude",
  ...over,
});

describe("parseTrigger", () => {
  it("requires the prefix on WhatsApp and strips it", () => {
    expect(parseTrigger("what's for dinner?", { requirePrefix: true })).toBeNull();
    expect(
      parseTrigger("@gema what's on the list?", { requirePrefix: true }),
    ).toEqual({ kind: "ask", prompt: "what's on the list?" });
    expect(parseTrigger("Gema: add milk ideas", { requirePrefix: true })).toEqual(
      { kind: "ask", prompt: "add milk ideas" },
    );
  });

  it("treats every Telegram message as an ask", () => {
    expect(parseTrigger("what's on the list?", { requirePrefix: false })).toEqual(
      { kind: "ask", prompt: "what's on the list?" },
    );
  });

  it("routes deep: to a deep task on both channels, with or without prefix", () => {
    expect(parseTrigger("deep: plan the week", { requirePrefix: true })).toEqual(
      { kind: "deep", prompt: "plan the week" },
    );
    expect(
      parseTrigger("@gema deep: plan the week", { requirePrefix: false }),
    ).toEqual({ kind: "deep", prompt: "plan the week" });
  });

  it("ignores empty and prefix-only messages", () => {
    expect(parseTrigger("  ", { requirePrefix: false })).toBeNull();
    expect(parseTrigger("@gema  ", { requirePrefix: true })).toBeNull();
  });
});

describe("chunkText + formatForChannel", () => {
  it("splits long replies at newlines and keeps short ones whole", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
    const long = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;
    const chunks = chunkText(long);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("a".repeat(3000));
  });

  it("converts markdown bold per channel and strips headings", () => {
    expect(formatForChannel("whatsapp", "**Plan**")).toBe("*Plan*");
    expect(formatForChannel("telegram", "**Plan**")).toBe("Plan");
    expect(formatForChannel("telegram", "## Dinner\nok")).toBe("Dinner\nok");
  });
});

describe("isAllowedSender", () => {
  const message = (over: Partial<ChannelMessage>): ChannelMessage => ({
    channel: "whatsapp",
    chatId: "c",
    senderId: "33612345678",
    text: "x",
    selfChat: false,
    ...over,
  });

  it("whatsapp: self-chat always, allowFrom by normalized number, others denied", () => {
    const cfg = config({
      channels: { whatsapp: { enabled: true, allowFrom: ["+33 6 12 34 56 78"] } },
    });
    expect(isAllowedSender(cfg, message({ selfChat: true }))).toBe(true);
    expect(isAllowedSender(cfg, message({}))).toBe(true);
    expect(isAllowedSender(cfg, message({ senderId: "4915112345678" }))).toBe(
      false,
    );
  });

  it("telegram: allowlist wins; empty allowlist binds to the first sender", () => {
    const cfg = config({
      channels: { telegram: { botToken: "t", allowFrom: ["42"] } },
    });
    const tg = message({ channel: "telegram", senderId: "42" });
    expect(isAllowedSender(cfg, tg)).toBe(true);
    expect(isAllowedSender(cfg, { ...tg, senderId: "43" })).toBe(false);

    const open = config({ channels: { telegram: { botToken: "t" } } });
    expect(isAllowedSender(open, tg, undefined)).toBe(true);
    expect(isAllowedSender(open, tg, "42")).toBe(true);
    expect(isAllowedSender(open, { ...tg, senderId: "43" }, "42")).toBe(false);
  });
});

describe("ChannelRouter", () => {
  function fakeTransport(): ChannelTransport & { sent: string[] } {
    const sent: string[] = [];
    return {
      name: "telegram",
      sent,
      start: async () => {},
      send: async (_chat, text) => {
        sent.push(text);
      },
      stop: async () => {},
    };
  }

  const tgMessage = (text: string, senderId = "42"): ChannelMessage => ({
    channel: "telegram",
    chatId: "chat-1",
    senderId,
    text,
    selfChat: false,
  });

  it("answers an allowed ask and binds the first telegram sender", async () => {
    const transport = fakeTransport();
    const bound: string[] = [];
    const router = new ChannelRouter(
      config({ channels: { telegram: { botToken: "t" } } }),
      [transport],
      {
        runAsk: async () => "Here's the list.",
        onTelegramOwnerBound: (id) => bound.push(id),
      },
    );
    await router.onMessage(transport, tgMessage("what's on the list?"));
    expect(transport.sent).toEqual(["Here's the list."]);
    expect(bound).toEqual(["42"]);
    // A different user is now denied.
    await router.onMessage(transport, tgMessage("hi", "43"));
    expect(transport.sent).toHaveLength(1);
  });

  it("collects a message that arrives while busy and runs it after", async () => {
    const transport = fakeTransport();
    let release: (() => void) | undefined;
    const asked: string[] = [];
    const router = new ChannelRouter(
      config({ channels: { telegram: { botToken: "t", allowFrom: ["42"] } } }),
      [transport],
      {
        runAsk: async (_cfg, trigger) => {
          asked.push(trigger.prompt);
          if (asked.length === 1) {
            await new Promise<void>((r) => {
              release = r;
            });
          }
          return `answer:${trigger.prompt}`;
        },
      },
    );
    const first = router.onMessage(transport, tgMessage("one"));
    await new Promise((r) => setTimeout(r, 10));
    // Two arrive while busy — only the newest is kept.
    await router.onMessage(transport, tgMessage("two"));
    await router.onMessage(transport, tgMessage("three"));
    release?.();
    await first;
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toEqual(["one", "three"]);
    expect(transport.sent).toEqual(["answer:one", "answer:three"]);
  });
});

describe("runChannelAsk", () => {
  let server: FakeServer;
  let cfg: GemaLocalConfig;

  beforeEach(async () => {
    server = await startFakeServer();
    cfg = config({ serverUrl: server.url });
  });
  afterEach(async () => {
    await server.close();
  });

  const fakeRuntime = (
    impl: (request: Parameters<typeof runAgentRuntime>[1]) => Promise<string>,
  ) =>
    vi.fn(async (_cfg: unknown, request: never) => ({
      text: await impl(request),
      usage: {} as never,
    })) as unknown as typeof runAgentRuntime;

  it("files deep tasks through the channel surface", async () => {
    server.respond("POST", "/gemaclaw/companion/task", 200, {
      ok: true,
      actionId: "task-1",
    });
    const reply = await runChannelAsk(cfg, {
      kind: "deep",
      prompt: "plan the week",
    });
    expect(reply).toBe(DEEP_FILED_REPLY);
    expect(server.requests[0]?.body).toMatchObject({
      token: "tok",
      prompt: "plan the week",
    });
  });

  it("runs asks with the four gema tools and returns the reply text", async () => {
    server.respond("POST", "/gemaclaw/companion/context", 200, {
      context: { listName: "Casa", items: [{ name: "Milk" }] },
    });
    const runRuntime = fakeRuntime(async (request) => {
      expect(request.tools.map((t) => t.name).sort()).toEqual([
        "complete_items",
        "post_to_household_chat",
        "propose_items",
        "read_household",
      ]);
      const read = request.tools.find((t) => t.name === "read_household");
      const result = await read?.handle({});
      expect(result?.text).toContain("Milk");
      return "Milk is already on the list.";
    });
    const reply = await runChannelAsk(
      cfg,
      { kind: "ask", prompt: "do we need milk?" },
      { runRuntime },
    );
    expect(reply).toBe("Milk is already on the list.");
  });

  it("falls back to a friendly line when the runtime returns nothing after proposing", async () => {
    server.respond("POST", "/gemaclaw/companion/propose", 200, {
      ok: true,
      actionId: "card-1",
    });
    const runRuntime = fakeRuntime(async (request) => {
      const propose = request.tools.find((t) => t.name === "propose_items");
      await propose?.handle({ items: [{ name: "Eggs" }] });
      return "";
    });
    const reply = await runChannelAsk(
      cfg,
      { kind: "ask", prompt: "add eggs" },
      { runRuntime },
    );
    expect(reply).toContain("approval card");
  });

  it("never throws — a runtime explosion becomes an apologetic reply", async () => {
    const runRuntime = fakeRuntime(async () => {
      throw new Error("boom");
    });
    const reply = await runChannelAsk(
      cfg,
      { kind: "ask", prompt: "hi" },
      { runRuntime },
    );
    expect(reply).toContain("Something went wrong");
  });
});
