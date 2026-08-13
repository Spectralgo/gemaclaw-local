import { resolveModel, type GemaLocalConfig } from "../config.js";
import type { RuntimeRunRequest, RuntimeRunResult } from "./types.js";
import { runClaudeAgent } from "./claude.js";
import { runCodexAppServerAgent } from "./codex-app-server.js";

export async function runAgentRuntime(
  config: GemaLocalConfig,
  request: Omit<RuntimeRunRequest, "model" | "reasoningEffort">,
): Promise<RuntimeRunResult> {
  const fullRequest = {
    ...request,
    model: resolveModel(config),
    reasoningEffort: config.reasoningEffort as RuntimeRunRequest["reasoningEffort"],
  };
  switch (config.runtime) {
    case "claude":
      return runClaudeAgent(fullRequest);
    case "codex":
      return runCodexAppServerAgent(fullRequest);
  }
}
