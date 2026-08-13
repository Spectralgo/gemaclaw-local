import { loadConfig, resolveModel } from "./config.js";
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

  const ran = new Set<string>();
  let backoff = POLL_INTERVAL_MS;
  let authFailures = 0;
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log("\n[gemaclaw] finishing up — Ctrl-C again to force quit");
  });

  while (!stopping) {
    try {
      const tasks = await pollTasks(config);
      backoff = POLL_INTERVAL_MS;
      authFailures = 0;
      const next = tasks.find((task) => !ran.has(task.actionId));
      if (next) {
        console.log(
          `[gemaclaw] task ${next.actionId}: "${next.prompt.slice(0, 80)}"`,
        );
        const claimed = await claimTask(config, next.actionId);
        if (!claimed) {
          console.log("[gemaclaw] another runner claimed it first");
        } else {
          ran.add(claimed.actionId);
          const startedAt = Date.now();
          await runClaimedTask(config, claimed);
          console.log(
            `[gemaclaw] task ${claimed.actionId} finished in ${Math.round((Date.now() - startedAt) / 1000)}s`,
          );
        }
      }
    } catch (err) {
      if (err instanceof CompanionAuthError) {
        // A server restart can briefly reject valid tokens — only give up
        // after several consecutive rejections.
        authFailures += 1;
        if (authFailures >= 3) {
          console.error(`\n${err.message}\n`);
          process.exit(1);
        }
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
