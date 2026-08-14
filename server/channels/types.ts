/** One normalized inbound text message from any channel. */
export interface ChannelMessage {
  channel: "whatsapp" | "telegram";
  /** Where to send the reply (WhatsApp JID / Telegram chat id). */
  chatId: string;
  /** Stable sender id (E.164-ish JID user part / Telegram user id). */
  senderId: string;
  text: string;
  /** WhatsApp self-chat ("Message yourself") — always allowed, but the
   * trigger prefix is still required there. */
  selfChat: boolean;
}

export type ChannelHandler = (message: ChannelMessage) => Promise<void>;

/** A messenger transport the router can drive. Kept deliberately thin so
 * the ask pipeline is testable with a fake transport (no phone, no bot). */
export interface ChannelTransport {
  name: "whatsapp" | "telegram";
  start(onMessage: ChannelHandler): Promise<void>;
  send(chatId: string, text: string): Promise<void>;
  stop(): Promise<void>;
}

/** Both messengers cap around 4096; break at newlines, never mid-sentence
 * (the OpenClaw/Hermes chunking convention). */
export function chunkText(text: string, max = 3900): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed.length > 0 ? [trimmed] : [];
  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
