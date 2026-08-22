import os from "node:os";
import { parseArgs } from "node:util";
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
 * Non-interactive pairing — the single pairing path shared by the desktop
 * app and scripts. `npm run setup` remains the interactive wrapper; this
 * takes the same answers as flags and prints one JSON result line.
 *
 *   tsx scripts/pair.ts --server https://gema.example.com --code ABCD1234 \
 *     [--name "My Mac"] [--runtime claude|codex] [--model m] \
 *     [--telegram-token t] [--whatsapp]
 */

interface PairResult {
  ok: boolean;
  configPath?: string;
  runtime?: RuntimeName;
  model?: string;
  error?: string;
}

function fail(error: string): never {
  const result: PairResult = { ok: false, error };
  console.log(JSON.stringify(result));
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      server: { type: "string" },
      code: { type: "string" },
      name: { type: "string" },
      runtime: { type: "string" },
      model: { type: "string" },
      "telegram-token": { type: "string" },
      whatsapp: { type: "boolean" },
    },
  });

  const serverUrl = (values.server ?? "").trim().replace(/\/+$/, "");
  if (!serverUrl || !isAllowedServerUrl(serverUrl)) {
    fail("Use an https:// server URL (plain http is only allowed for localhost).");
  }

  const code = (values.code ?? "").trim().toUpperCase();
  if (code.length !== 8) {
    fail("The pairing code is 8 characters (Settings → GemaClaw Local).");
  }

  const runtime = (values.runtime ?? "claude") as RuntimeName;
  if (runtime !== "claude" && runtime !== "codex") {
    fail('Runtime must be "claude" or "codex".');
  }

  const deviceName =
    (values.name ?? "").trim() || os.hostname().replace(/\.local$/, "");
  const telegramToken = (values["telegram-token"] ?? "").trim();
  if (telegramToken && !/^\d+:[\w-]{30,}$/.test(telegramToken)) {
    fail("That doesn't look like a Telegram bot token (123456:ABC-…).");
  }

  let token: string;
  try {
    token = await pair(serverUrl, code, deviceName);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const channels: GemaLocalConfig["channels"] = {};
  if (telegramToken) channels.telegram = { botToken: telegramToken };
  if (values.whatsapp) channels.whatsapp = { enabled: true };

  const model = (values.model ?? "").trim();
  const config: GemaLocalConfig = {
    serverUrl,
    companionToken: token,
    runtime,
    ...(model ? { model } : {}),
    ...(Object.keys(channels).length > 0 ? { channels } : {}),
  };
  saveConfig(config);

  const result: PairResult = {
    ok: true,
    configPath: configPath(),
    runtime,
    model: model || DEFAULT_MODELS[runtime],
  };
  console.log(JSON.stringify(result));
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
