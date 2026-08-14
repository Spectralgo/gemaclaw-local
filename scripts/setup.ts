import os from "node:os";
import prompts from "prompts";
import {
  configPath,
  DEFAULT_MODELS,
  type GemaLocalConfig,
  isAllowedServerUrl,
  type RuntimeName,
  saveConfig,
} from "../server/config.js";
import { pair } from "../server/gema/client.js";

/**
 * Interactive pairing. Prereq: a household owner opened Gema's settings
 * (Settings → GemaClaw Local), clicked "Pair a computer", and has the
 * 8-character code on screen. This exchanges it for the companion token
 * and writes ~/.gemaclaw/config.json.
 */
async function main(): Promise<void> {
  console.log("GemaClaw Local setup — pair this computer with your household.\n");

  const answers = await prompts(
    [
      {
        type: "text",
        name: "serverUrl",
        message: "Gema server URL",
        initial: "https://gema.spectralgo.com",
        validate: (value: string) =>
          isAllowedServerUrl(value.trim().replace(/\/+$/, "")) ||
          "Use an https:// URL (plain http is only allowed for localhost)",
      },
      {
        type: "text",
        name: "code",
        message: "Pairing code (from Settings → GemaClaw Local)",
        validate: (value: string) =>
          value.trim().length === 8 || "The code is 8 characters",
      },
      {
        type: "text",
        name: "deviceName",
        message: "Name for this computer",
        initial: os.hostname().replace(/\.local$/, ""),
      },
      {
        type: "select",
        name: "runtime",
        message: "Which subscription runs the agent?",
        choices: [
          {
            title: "Claude Code (uses your `claude` login)",
            value: "claude",
          },
          {
            title: "Codex / ChatGPT (uses your `codex login`)",
            value: "codex",
          },
        ],
      },
      {
        type: "text",
        name: "model",
        message: "Model (empty = default)",
        initial: "",
      },
      {
        type: "confirm",
        name: "telegram",
        message:
          "Connect a Telegram bot? (create one with @BotFather, ~1 min — recommended)",
        initial: true,
      },
      {
        type: (prev: boolean) => (prev ? "password" : null),
        name: "telegramToken",
        message: "Telegram bot token (from @BotFather)",
        validate: (value: string) =>
          /^\d+:[\w-]{30,}$/.test(value.trim()) ||
          "That doesn't look like a bot token (123456:ABC-…)",
      },
      {
        type: "confirm",
        name: "whatsapp",
        message:
          "Link WhatsApp? (scan a QR with your phone on first start; @gema prefix required)",
        initial: false,
      },
    ],
    {
      onCancel: () => {
        console.log("Setup cancelled.");
        process.exit(1);
      },
    },
  );

  const runtime = answers.runtime as RuntimeName;
  const serverUrl = String(answers.serverUrl).trim().replace(/\/+$/, "");
  console.log("\nPairing…");
  const token = await pair(
    serverUrl,
    String(answers.code).trim().toUpperCase(),
    String(answers.deviceName).trim(),
  );

  const channels: GemaLocalConfig["channels"] = {};
  if (answers.telegram && answers.telegramToken) {
    channels.telegram = { botToken: String(answers.telegramToken).trim() };
  }
  if (answers.whatsapp) {
    channels.whatsapp = { enabled: true };
  }

  const config: GemaLocalConfig = {
    serverUrl,
    companionToken: token,
    runtime,
    ...(String(answers.model).trim()
      ? { model: String(answers.model).trim() }
      : {}),
    ...(Object.keys(channels).length > 0 ? { channels } : {}),
  };
  saveConfig(config);

  console.log(`\nPaired ✓  (config: ${configPath()})`);
  console.log(
    `Runtime: ${runtime} — default model ${config.model ?? DEFAULT_MODELS[runtime]}`,
  );
  console.log("\nWhat's next:");
  console.log("  1. npm start        — the companion begins polling for work");
  if (config.channels?.telegram) {
    console.log(
      "  2. Open your Telegram bot and say hi — the first sender claims it.",
    );
  }
  if (config.channels?.whatsapp?.enabled) {
    console.log(
      `  ${config.channels.telegram ? "3" : "2"}. WhatsApp: scan the QR that appears on start (Settings → Linked devices), then message yourself "@gema hello".`,
    );
  }
  console.log(
    "  Try a deep task from the Gema app chat:  deep: plan three dinners from our list",
  );
  console.log("\nHealth check any time:  npm run doctor");
  console.log("Full guide: TUTORIAL.md");
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
