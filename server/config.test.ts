import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isAllowedServerUrl,
  loadConfig,
  resolveModel,
  saveConfig,
  type GemaLocalConfig,
} from "./config.js";

describe("GemaClaw Local config", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "gemaclaw-config-test-"));
    previousHome = process.env.GEMACLAW_HOME;
    process.env.GEMACLAW_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.GEMACLAW_HOME;
    else process.env.GEMACLAW_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("tells the user to run setup when the config file is missing", () => {
    expect(() => loadConfig()).toThrow(/npm run setup/);
  });

  it("roundtrips a saved config", () => {
    const config: GemaLocalConfig = {
      serverUrl: "https://gema.example",
      companionToken: "companion-token",
      runtime: "codex",
      model: "gpt-5.5",
      reasoningEffort: "high",
    };

    saveConfig(config);

    expect(loadConfig()).toEqual(config);
  });

  it("strips trailing slashes when loading", () => {
    saveConfig({
      serverUrl: "https://gema.example///",
      companionToken: "companion-token",
      runtime: "claude",
    });

    expect(loadConfig().serverUrl).toBe("https://gema.example");
  });

  it("resolves runtime defaults and explicit model overrides", () => {
    const config: GemaLocalConfig = {
      serverUrl: "https://gema.example",
      companionToken: "companion-token",
      runtime: "claude",
    };

    expect(resolveModel(config)).toBe("claude-sonnet-4-6");
    expect(resolveModel({ ...config, model: "claude-opus-4-6" })).toBe("claude-opus-4-6");
  });

  it("requires https except for loopback dev servers", () => {
    expect(isAllowedServerUrl("https://gema.spectralgo.com")).toBe(true);
    expect(isAllowedServerUrl("http://localhost:3003")).toBe(true);
    expect(isAllowedServerUrl("http://127.0.0.1:3003")).toBe(true);
    expect(isAllowedServerUrl("http://gema.spectralgo.com")).toBe(false);
    expect(isAllowedServerUrl("http://192.168.1.10:3003")).toBe(false);
    expect(isAllowedServerUrl("ftp://gema.example")).toBe(false);
    expect(isAllowedServerUrl("not a url")).toBe(false);
  });
});
