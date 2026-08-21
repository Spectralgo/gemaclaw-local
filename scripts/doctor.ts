import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { configDir, loadConfig, resolveModel } from "../server/config.js";
import { pollTasks } from "../server/gema/client.js";

/**
 * `npm run doctor` — onboarding health check. Verifies every link in the
 * chain and says exactly what to fix, in order.
 */

let failures = 0;
const ok = (label: string, detail = "") =>
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
const bad = (label: string, fix: string) => {
  failures += 1;
  console.log(`  ✗ ${label}\n      → ${fix}`);
};

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}

async function main(): Promise<void> {
  console.log("GemaClaw Local — doctor\n");

  // 1. Config
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
    ok("config", path.join(configDir(), "config.json"));
  } catch (err) {
    bad(
      "config",
      err instanceof Error ? err.message : "run `npm run setup`",
    );
    return done();
  }

  // 2. Runtime CLI
  const runtimeBinary = config.runtime === "claude" ? "claude" : "codex";
  if (hasBinary(runtimeBinary)) {
    ok(`runtime (${config.runtime})`, `model ${resolveModel(config)}`);
  } else {
    bad(
      `runtime (${config.runtime})`,
      config.runtime === "claude"
        ? "install + sign in: npm i -g @anthropic-ai/claude-code, then run `claude`"
        : "install + sign in: npm i -g @openai/codex, then run `codex login`",
    );
  }

  // 3. Server + pairing (one call proves both)
  try {
    // probe: a health check must not heartbeat — the server would route
    // deep tasks to this companion even though the poller isn't running.
    await pollTasks(config, { probe: true });
    ok("server + pairing", config.serverUrl);
  } catch (err) {
    bad(
      "server + pairing",
      err instanceof Error && err.name === "CompanionAuthError"
        ? "token rejected — re-pair from Gema Settings → GemaClaw Local, then `npm run setup`"
        : `cannot reach ${config.serverUrl} — is it up, and is GEMA_LOCAL_BRAIN enabled there?`,
    );
  }

  // 4. Telegram
  const telegram = config.channels?.telegram;
  if (telegram?.botToken) {
    try {
      const res = await fetch(
        `${(telegram.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "")}/bot${telegram.botToken}/getMe`,
        { signal: AbortSignal.timeout(15_000) },
      );
      const json = (await res.json()) as {
        ok?: boolean;
        result?: { username?: string };
      };
      if (json.ok) {
        const bound = telegram.allowFrom?.length
          ? `bound to ${telegram.allowFrom.join(", ")}`
          : "unclaimed — the first person to message it becomes the owner";
        ok("telegram", `@${json.result?.username} · ${bound}`);
      } else {
        bad("telegram", "token rejected — get a fresh one from @BotFather");
      }
    } catch {
      bad("telegram", "could not reach api.telegram.org — check your network");
    }
  } else {
    console.log("  · telegram — not configured (optional)");
  }

  // 5. WhatsApp
  const whatsapp = config.channels?.whatsapp;
  if (whatsapp?.enabled) {
    const linked = fs.existsSync(
      path.join(configDir(), "whatsapp-auth", "creds.json"),
    );
    if (linked) ok("whatsapp", "linked — session saved");
    else
      console.log(
        "  · whatsapp — enabled, not linked yet (scan the QR on next `npm start`)",
      );
  } else {
    console.log("  · whatsapp — not configured (optional)");
  }

  done();
}

function done(): void {
  console.log(
    failures === 0
      ? "\nAll good — `npm start` and talk to Gema."
      : `\n${failures} issue${failures > 1 ? "s" : ""} to fix (see arrows above).`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("doctor crashed:", err);
  process.exit(1);
});
