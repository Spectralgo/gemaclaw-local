import type { GemaLocalConfig } from "../config.js";
import { parseTrigger, runChannelAsk } from "./ask-runner.js";
import {
  type ChannelMessage,
  type ChannelTransport,
  chunkText,
} from "./types.js";

/**
 * The channel router: deny-by-default access, one ask at a time per chat,
 * and a "collect" lane — a message arriving while Gema is busy replaces
 * any earlier waiting one and runs next (the OpenClaw queue shape, size 1).
 */

export interface RouterDeps {
  runAsk?: typeof runChannelAsk;
  /** Telegram auto-bind persistence hook (first user becomes the owner). */
  onTelegramOwnerBound?: (userId: string) => void;
}

export function isAllowedSender(
  config: GemaLocalConfig,
  message: ChannelMessage,
  boundTelegramOwner?: string,
): boolean {
  if (message.channel === "whatsapp") {
    if (message.selfChat) return true;
    const allow = config.channels?.whatsapp?.allowFrom ?? [];
    return allow.some(
      (entry) => normalizePhone(entry) === normalizePhone(message.senderId),
    );
  }
  const allow = config.channels?.telegram?.allowFrom ?? [];
  if (allow.length > 0) return allow.includes(message.senderId);
  // Empty allowlist: the first user to message the bot claims it.
  return boundTelegramOwner === undefined ||
    boundTelegramOwner === message.senderId;
}

const normalizePhone = (value: string) => value.replace(/[^0-9]/g, "");

export class ChannelRouter {
  private readonly busy = new Map<string, boolean>();
  private readonly pending = new Map<string, ChannelMessage>();
  private telegramOwner: string | undefined;

  constructor(
    private readonly config: GemaLocalConfig,
    private readonly transports: ChannelTransport[],
    private readonly deps: RouterDeps = {},
  ) {
    // A configured allowlist wins; the bind slot only backs the empty case.
    this.telegramOwner = config.channels?.telegram?.allowFrom?.[0];
  }

  async start(): Promise<void> {
    for (const transport of this.transports) {
      // Per-transport isolation: a bad Telegram token must not stop
      // WhatsApp from starting (and vice versa).
      try {
        await transport.start((message) => this.onMessage(transport, message));
        console.log(`[channels] ${transport.name} ready`);
      } catch (err) {
        console.error(`[channels] ${transport.name} failed to start:`, err);
      }
    }
  }

  async stop(): Promise<void> {
    for (const transport of this.transports) {
      await transport.stop().catch(() => {});
    }
  }

  private laneKey(message: ChannelMessage): string {
    return `${message.channel}:${message.chatId}`;
  }

  async onMessage(
    transport: ChannelTransport,
    message: ChannelMessage,
  ): Promise<void> {
    if (!isAllowedSender(this.config, message, this.telegramOwner)) return;

    // First-contact bind for a dedicated Telegram bot with no allowlist.
    if (
      message.channel === "telegram" &&
      (this.config.channels?.telegram?.allowFrom ?? []).length === 0 &&
      this.telegramOwner === undefined
    ) {
      this.telegramOwner = message.senderId;
      this.deps.onTelegramOwnerBound?.(message.senderId);
      console.log(
        `[channels] telegram bound to user ${message.senderId} (first contact)`,
      );
    }

    const trigger = parseTrigger(message.text, {
      requirePrefix: message.channel === "whatsapp",
    });
    if (!trigger) return;

    const lane = this.laneKey(message);
    if (this.busy.get(lane)) {
      // Collect: keep only the newest waiting message per chat.
      this.pending.set(lane, message);
      return;
    }
    this.busy.set(lane, true);
    try {
      const runAsk = this.deps.runAsk ?? runChannelAsk;
      const reply = await runAsk(this.config, trigger);
      for (const chunk of chunkText(formatForChannel(message.channel, reply))) {
        await transport.send(message.chatId, chunk);
      }
    } catch (err) {
      console.error(`[channels] ${lane} reply failed:`, err);
    } finally {
      this.busy.set(lane, false);
      const queued = this.pending.get(lane);
      if (queued) {
        this.pending.delete(lane);
        // Run the collected message on a fresh stack.
        void this.onMessage(transport, queued);
      }
    }
  }
}

/** Messenger-safe text: strip markdown the channels render literally. */
export function formatForChannel(
  channel: ChannelMessage["channel"],
  text: string,
): string {
  const cleaned = text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, channel === "whatsapp" ? "*$1*" : "$1")
    .replace(/__([^_]+)__/g, "$1");
  return cleaned;
}
