import { ChannelRouter } from "./channels/router.js";
import { TelegramTransport } from "./channels/telegram.js";
import type { ChannelTransport } from "./channels/types.js";
import { WhatsAppTransport } from "./channels/whatsapp.js";
import { loadConfig, resolveModel, saveConfig } from "./config.js";
import {
  claimTask,
  CompanionAuthError,
  pollTasks,
} from "./gema/client.js";
import { runClaimedTask } from "./task-runner.js";

/**
 * GemaClaw Local — the poller. One process, one household, one task at a
 * time: poll for approved deep tasks routed to this companion, claim,
 * run on the configured subscription runtime, report, repeat.
 */

const POLL_INTERVAL_MS = 5_000;
const POLL_BACKOFF_MAX_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const config = loadConfig();
  console.log("════════════════════════════════════════════════");
  console.log("  GemaClaw Local — your computer is Gema's brain");
  console.log(`  server   ${config.serverUrl}`);
  console.log(`  runtime  ${config.runtime} (${resolveModel(config)})`);
  console.log("  waiting for approved deep tasks…");
  console.log("════════════════════════════════════════════════");

  // Messenger channels (Telegram bot / linked WhatsApp) — optional, and a
  // channel failure must never take the deep-task poller down.
  const transports: ChannelTransport[] = [];
  if (config.channels?.telegram?.botToken) {
    transports.push(new TelegramTransport(config.channels.telegram));
  }
  if (config.channels?.whatsapp?.enabled) {
    transports.push(new WhatsAppTransport());
  }
  let router: ChannelRouter | undefined;
  if (transports.length > 0) {
    router = new ChannelRouter(config, transports, {
      onTelegramOwnerBound: (userId) => {
        const telegram = config.channels?.telegram;
        if (!telegram) return;
        try {
          saveConfig({
            ...config,
            channels: {
              ...config.channels,
              telegram: { ...telegram, allowFrom: [userId] },
            },
          });
        } catch (err) {
          console.error("[channels] could not persist telegram owner:", err);
        }
      },
    });
    try {
      await router.start();
    } catch (err) {
      console.error(
        "[channels] channel startup failed (deep-task loop continues):",
        err,
      );
    }
  }

  const ran = new Set<string>();
  let backoff = POLL_INTERVAL_MS;
  let authFailures = 0;
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    void router?.stop();
    console.log("\n[gemaclaw] finishing up — Ctrl-C again to force quit");
  });

  while (!stopping) {
    try {
      const tasks = await pollTasks(config);
      backoff = POLL_INTERVAL_MS;
      authFailures = 0;
      const next = tasks.find((task) => !ran.has(task.actionId));
      if (next && !stopping) {
        console.log(
          `[gemaclaw] task ${next.actionId}: "${next.prompt.slice(0, 80)}"`,
        );
        const claimed = await claimTask(config, next.actionId);
        if (!claimed) {
          // Lost race (or already claimed) — never poll-spin on the same
          // id while newer tasks wait behind it.
          ran.add(next.actionId);
          console.log("[gemaclaw] another runner claimed it first");
        } else if (stopping) {
          console.log(
            "[gemaclaw] shutdown requested — leaving the claimed task to the server watchdog",
          );
        } else {
          ran.add(claimed.actionId);
          const startedAt = Date.now();
          const outcome = await runClaimedTask(config, claimed);
          console.log(
            `[gemaclaw] task ${claimed.actionId} finished in ${Math.round((Date.now() - startedAt) / 1000)}s`,
          );
          // If a messenger chat filed this task, report the wrap-up there.
          await router?.notifyTaskDone(claimed.actionId, outcome);
        }
      }
    } catch (err) {
      if (err instanceof CompanionAuthError) {
        // A server restart can briefly reject valid tokens — only give up
        // after several CONSECUTIVE rejections.
        authFailures += 1;
        if (authFailures >= 3) {
          console.error(`\n${err.message}\n`);
          process.exit(1);
        }
      } else {
        authFailures = 0;
      }
      console.error(`[gemaclaw] poll failed (retrying in ${backoff / 1000}s):`, err);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, POLL_BACKOFF_MAX_MS);
      continue;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});
