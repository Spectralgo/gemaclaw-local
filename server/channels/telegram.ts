import type { TelegramChannelConfig } from "../config.js";
import type { ChannelHandler, ChannelTransport } from "./types.js";

/**
 * Telegram transport — raw Bot API over long polling. No webhook, no
 * public URL, no extra dependency: `getUpdates` with a 50s hold, offset
 * acknowledgment, and `sendMessage` replies. The bot chat is dedicated to
 * Gema, so every DM is an ask (no prefix). Create the bot with @BotFather.
 */

const POLL_TIMEOUT_S = 50;
const RETRY_MS = 5_000;

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: { id: number; type?: string };
    from?: { id: number; is_bot?: boolean };
  };
}

export class TelegramTransport implements ChannelTransport {
  readonly name = "telegram" as const;
  private stopped = false;
  private abort = new AbortController();

  constructor(private readonly config: TelegramChannelConfig) {}

  private api(method: string): string {
    const base = (this.config.apiBase ?? "https://api.telegram.org").replace(
      /\/+$/,
      "",
    );
    return `${base}/bot${this.config.botToken}/${method}`;
  }

  private async call<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await fetch(this.api(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: T;
      description?: string;
    } | null;
    if (!res.ok || !json?.ok) {
      throw new Error(
        `telegram ${method} → ${res.status} ${json?.description ?? ""}`,
      );
    }
    return json.result as T;
  }

  async start(onMessage: ChannelHandler): Promise<void> {
    // Fail fast on a bad token so setup mistakes surface immediately.
    const me = await this.call<{ username?: string }>("getMe", {});
    console.log(`[telegram] connected as @${me.username ?? "unknown"}`);
    void this.pollLoop(onMessage);
  }

  private async pollLoop(onMessage: ChannelHandler): Promise<void> {
    let offset = 0;
    while (!this.stopped) {
      try {
        const updates = await this.call<TelegramUpdate[]>(
          "getUpdates",
          {
            timeout: POLL_TIMEOUT_S,
            offset,
            allowed_updates: ["message"],
          },
          AbortSignal.any([
            this.abort.signal,
            AbortSignal.timeout((POLL_TIMEOUT_S + 10) * 1000),
          ]),
        );
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          const message = update.message;
          if (
            !message?.text ||
            !message.chat ||
            message.chat.type !== "private" ||
            !message.from ||
            message.from.is_bot
          ) {
            continue;
          }
          await onMessage({
            channel: "telegram",
            chatId: String(message.chat.id),
            senderId: String(message.from.id),
            text: message.text,
            selfChat: false,
          });
        }
      } catch (err) {
        if (this.stopped) return;
        console.error(`[telegram] poll failed (retrying):`, err);
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
    }
  }

  async send(chatId: string, text: string): Promise<void> {
    await this.call("sendMessage", { chat_id: Number(chatId), text });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
  }
}
