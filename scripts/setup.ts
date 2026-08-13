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

  const config: GemaLocalConfig = {
    serverUrl,
    companionToken: token,
    runtime,
    ...(String(answers.model).trim()
      ? { model: String(answers.model).trim() }
      : {}),
  };
  saveConfig(config);

  console.log(`\nPaired ✓  (config: ${configPath()})`);
  console.log(
    `Runtime: ${runtime} — default model ${config.model ?? DEFAULT_MODELS[runtime]}`,
  );
  console.log("\nStart the companion with:  npm start");
  console.log(
    "Then ask Gema in chat:  @Gema deep: plan three dinners from our list",
  );
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
