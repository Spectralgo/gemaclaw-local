import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type RuntimeName = "claude" | "codex";

export interface GemaLocalConfig {
  serverUrl: string;
  companionToken: string;
  runtime: RuntimeName;
  model?: string;
  reasoningEffort?: string;
}

export const DEFAULT_MODELS: Record<RuntimeName, string> = {
  claude: "claude-sonnet-4-6",
  codex: "gpt-5.5",
};

export function configDir(): string {
  return process.env.GEMACLAW_HOME ?? path.join(os.homedir(), ".gemaclaw");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function loadConfig(): GemaLocalConfig {
  const filePath = configPath();
  let value: unknown;

  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw configError(filePath);
  }

  if (!isConfig(value)) {
    throw configError(filePath);
  }

  const serverUrl = value.serverUrl.replace(/\/+$/, "");
  if (!serverUrl) {
    throw configError(filePath);
  }

  return { ...value, serverUrl };
}

export function saveConfig(config: GemaLocalConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configPath(), 0o600);
}

export function resolveModel(config: GemaLocalConfig): string {
  return config.model ?? DEFAULT_MODELS[config.runtime];
}

function isConfig(value: unknown): value is GemaLocalConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return (
    typeof config.serverUrl === "string" &&
    config.serverUrl.length > 0 &&
    typeof config.companionToken === "string" &&
    config.companionToken.length > 0 &&
    (config.runtime === "claude" || config.runtime === "codex") &&
    (config.model === undefined || typeof config.model === "string") &&
    (config.reasoningEffort === undefined || typeof config.reasoningEffort === "string")
  );
}

function configError(filePath: string): Error {
  return new Error(
    `GemaClaw Local config is missing or invalid at ${filePath}. Run \`npm run setup\` to configure it.`,
  );
}
