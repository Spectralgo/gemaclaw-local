import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeServer, type FakeServer } from "../gema/fake-server.js";
import { TelegramTransport } from "./telegram.js";
import type { ChannelMessage } from "./types.js";

let server: FakeServer;
let transport: TelegramTransport;

const TOKEN = "12345:test-token-abcdefghijklmnopqrstuvwxyz";
const base = (path: string) => `/bot${TOKEN}/${path}`;

beforeEach(async () => {
  server = await startFakeServer();
  transport = new TelegramTransport({
    botToken: TOKEN,
    apiBase: server.url,
  });
  server.respond("POST", base("getMe"), 200, {
    ok: true,
    result: { username: "gema_test_bot" },
  });
  server.respond("POST", base("sendMessage"), 200, { ok: true, result: {} });
});

afterEach(async () => {
  await transport.stop();
  await server.close();
});

describe("TelegramTransport", () => {
  it("fails fast on a bad token", async () => {
    server.respond("POST", base("getMe"), 401, {
      ok: false,
      description: "Unauthorized",
    });
    await expect(transport.start(async () => {})).rejects.toThrow(/401/);
  });

  it("long-polls, filters to private human texts, acks the offset, and sends replies", async () => {
    server.respondSeq("POST", base("getUpdates"), [
      {
        status: 200,
        body: {
          ok: true,
          result: [
            {
              update_id: 7,
              message: {
                text: "what's on the list?",
                chat: { id: 99, type: "private" },
                from: { id: 42 },
              },
            },
            {
              update_id: 8,
              message: {
                text: "group noise",
                chat: { id: -100, type: "supergroup" },
                from: { id: 42 },
              },
            },
            {
              update_id: 9,
              message: {
                text: "bot noise",
                chat: { id: 99, type: "private" },
                from: { id: 500, is_bot: true },
              },
            },
          ],
        },
      },
      // Sticky empty response keeps the loop quiet afterwards.
      { status: 200, body: { ok: true, result: [] } },
    ]);

    const received: ChannelMessage[] = [];
    await transport.start(async (message) => {
      received.push(message);
    });
    await new Promise((r) => setTimeout(r, 150));

    expect(received).toEqual([
      {
        channel: "telegram",
        chatId: "99",
        senderId: "42",
        text: "what's on the list?",
        selfChat: false,
      },
    ]);

    // The second getUpdates call must acknowledge past update 9.
    const polls = server.requests.filter((r) =>
      r.path.endsWith("/getUpdates"),
    );
    expect(polls.length).toBeGreaterThanOrEqual(2);
    expect((polls[1]?.body as { offset?: number }).offset).toBe(10);

    await transport.send("99", "On the list: milk.");
    const sent = server.requests.find((r) => r.path.endsWith("/sendMessage"));
    expect(sent?.body).toEqual({ chat_id: 99, text: "On the list: milk." });
  });
});
