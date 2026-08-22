import fs from "node:fs";
import path from "node:path";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { configDir } from "../config.js";
import type { ChannelHandler, ChannelTransport } from "./types.js";

/**
 * WhatsApp transport — Baileys links the companion as a device on the
 * member's OWN WhatsApp account (QR scan, exactly like WhatsApp Web).
 * Session credentials live under ~/.gemaclaw/whatsapp-auth (0700), the
 * same trust tier as the companion token.
 *
 * A linked account is a real person's: the router requires the @gema
 * prefix, and this transport additionally never surfaces group chats,
 * broadcasts, or its own outbound replies.
 */

/** Minimal silent logger satisfying Baileys' pino-shaped interface. */
const silentLogger = {
  level: "silent",
  child() {
    return silentLogger;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  // biome-ignore lint/suspicious/noExplicitAny: pino interface stand-in
} as any;

const bareJid = (jid: string | undefined | null): string =>
  (jid ?? "").split(":")[0].split("@")[0];

export class WhatsAppTransport implements ChannelTransport {
  readonly name = "whatsapp" as const;
  private socket: ReturnType<typeof makeWASocket> | undefined;
  private stopped = false;
  private readonly sentIds = new Set<string>();
  /** Recently-sent reply texts (bounded): belt-and-braces against our own
   * self-chat replies echoing back before their id lands in sentIds
   * (event-order races, replays after reconnect). */
  private readonly sentTexts: string[] = [];

  private markSent(id: string | undefined | null, text: string): void {
    if (id) {
      this.sentIds.add(id);
      if (this.sentIds.size > 500) {
        const oldest = this.sentIds.values().next().value;
        if (oldest) this.sentIds.delete(oldest);
      }
    }
    this.sentTexts.push(text);
    if (this.sentTexts.length > 50) this.sentTexts.shift();
  }

  private isOwnEcho(id: string | undefined | null, text: string): boolean {
    if (id && this.sentIds.has(id)) return true;
    return this.sentTexts.includes(text);
  }

  async start(onMessage: ChannelHandler): Promise<void> {
    await this.connect(onMessage);
  }

  private async connect(onMessage: ChannelHandler): Promise<void> {
    const authDir = path.join(configDir(), "whatsapp-auth");
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const socket = makeWASocket({ auth: state, logger: silentLogger });
    this.socket = socket;
    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        if (process.env.GEMACLAW_DESKTOP === "1") {
          // Structured line for the desktop shell, which renders a
          // scannable QR in the window (ASCII QRs are unreadable there).
          console.log(`[whatsapp] qr ${qr}`);
        } else {
          console.log(
            "\n[whatsapp] Link this computer: WhatsApp → Settings → Linked devices → Link a device, then scan:\n",
          );
          qrcode.generate(qr, { small: true });
        }
      }
      if (connection === "open") {
        console.log(
          `[whatsapp] linked as ${bareJid(socket.user?.id) || "unknown"} — message yourself with "@gema …" to talk to Gema`,
        );
      } else if (connection === "close" && !this.stopped) {
        const statusCode = (
          lastDisconnect?.error as
            | { output?: { statusCode?: number } }
            | undefined
        )?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          console.error(
            "[whatsapp] this device was unlinked — restart the companion to scan a fresh QR",
          );
          fs.rmSync(authDir, { recursive: true, force: true });
          return;
        }
        console.log("[whatsapp] connection closed — reconnecting…");
        setTimeout(() => {
          if (!this.stopped) void this.connect(onMessage);
        }, 3_000);
      }
    });

    socket.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      const selfBare = bareJid(socket.user?.id);
      for (const msg of messages) {
        const remoteJid = msg.key.remoteJid ?? "";
        if (!remoteJid.endsWith("@s.whatsapp.net")) continue; // DMs only
        const text =
          msg.message?.conversation ??
          msg.message?.extendedTextMessage?.text ??
          "";
        if (!text) continue;
        if (this.isOwnEcho(msg.key.id, text)) continue; // our own reply
        const selfChat = bareJid(remoteJid) === selfBare && selfBare !== "";
        // Outside self-chat, our own outgoing messages are not asks.
        if (msg.key.fromMe && !selfChat) continue;
        await onMessage({
          channel: "whatsapp",
          chatId: remoteJid,
          senderId: bareJid(remoteJid),
          text,
          selfChat,
        });
      }
    });
  }

  async typing(chatId: string): Promise<void> {
    await this.socket
      ?.sendPresenceUpdate("composing", chatId)
      .catch(() => undefined);
  }

  async send(chatId: string, text: string): Promise<void> {
    if (!this.socket) throw new Error("whatsapp socket not connected");
    await this.socket
      .sendPresenceUpdate("composing", chatId)
      .catch(() => undefined);
    // Record BEFORE sending so an upsert echo racing the send response
    // can never be re-ingested as a fresh ask.
    this.markSent(null, text);
    const sent = await this.socket.sendMessage(chatId, { text });
    if (sent?.key?.id) this.markSent(sent.key.id, text);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.socket?.end(undefined);
  }
}
