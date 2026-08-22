import { parseArgs } from "node:util";
import {
  DEFAULT_ROUTINES,
  latestSlot,
  loadAutoState,
  nextSlot,
  saveAutoState,
} from "../server/auto/scheduler.js";
import {
  type AutoConfig,
  type GemaLocalConfig,
  loadConfig,
  saveConfig,
} from "../server/config.js";
import { runProactiveRoutine } from "../server/channels/ask-runner.js";
import { postHouseholdMessage } from "../server/gema/client.js";

/**
 * Auto-mode control plane — one JSON line out, shared by the desktop app
 * (IPC) and the CLI:
 *
 *   tsx scripts/auto-config.ts --get
 *   tsx scripts/auto-config.ts --enable | --disable
 *   tsx scripts/auto-config.ts --toggle-routine <id>
 *   tsx scripts/auto-config.ts --set-auto '<json AutoConfig>'
 *   tsx scripts/auto-config.ts --run-now <id> [--dry]
 */

function out(value: unknown): void {
  console.log(JSON.stringify(value));
}

function fail(error: string): never {
  out({ ok: false, error });
  process.exit(1);
}

function withDefaults(config: GemaLocalConfig): AutoConfig {
  return (
    config.auto ?? { enabled: false, routines: structuredClone(DEFAULT_ROUTINES) }
  );
}

function view(config: GemaLocalConfig) {
  const auto = withDefaults(config);
  const state = loadAutoState();
  const now = new Date();
  return {
    ok: true,
    auto,
    runsToday: state.runsDay === nowDayKey(now) ? state.runsToday : 0,
    nextRuns: Object.fromEntries(
      auto.routines.map((routine) => [
        routine.id,
        routine.enabled && auto.enabled
          ? (nextSlot(routine, now)?.toISOString() ?? null)
          : null,
      ]),
    ),
  };
}

function nowDayKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      get: { type: "boolean" },
      enable: { type: "boolean" },
      disable: { type: "boolean" },
      "toggle-routine": { type: "string" },
      "set-auto": { type: "string" },
      "run-now": { type: "string" },
      dry: { type: "boolean" },
    },
  });

  let config: GemaLocalConfig;
  try {
    config = loadConfig();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  if (values.get) {
    out(view(config));
    return;
  }

  if (values.enable || values.disable) {
    const auto = withDefaults(config);
    auto.enabled = Boolean(values.enable);
    saveConfig({ ...config, auto });
    out(view({ ...config, auto }));
    return;
  }

  const toggleId = values["toggle-routine"];
  if (toggleId) {
    const auto = withDefaults(config);
    const routine = auto.routines.find((r) => r.id === toggleId);
    if (!routine) fail(`No routine "${toggleId}".`);
    routine.enabled = !routine.enabled;
    saveConfig({ ...config, auto });
    out(view({ ...config, auto }));
    return;
  }

  if (values["set-auto"]) {
    let parsed: AutoConfig;
    try {
      parsed = JSON.parse(values["set-auto"]);
    } catch {
      fail("--set-auto expects JSON.");
    }
    if (
      typeof parsed !== "object" ||
      typeof parsed.enabled !== "boolean" ||
      !Array.isArray(parsed.routines)
    ) {
      fail("AutoConfig needs {enabled, routines[]}.");
    }
    saveConfig({ ...config, auto: parsed });
    out(view({ ...config, auto: parsed }));
    return;
  }

  const runId = values["run-now"];
  if (runId) {
    const auto = withDefaults(config);
    const routine = auto.routines.find((r) => r.id === runId);
    if (!routine) fail(`No routine "${runId}".`);
    // Claim the current slot BEFORE running: a manual run must not race
    // the poller's scheduler into a duplicate post.
    const slot = latestSlot(routine, new Date());
    if (slot) {
      const state = loadAutoState();
      if ((state.lastSlotRun[routine.id] ?? 0) < slot.getTime()) {
        state.lastSlotRun[routine.id] = slot.getTime();
        saveAutoState(state);
      }
    }
    const result = await runProactiveRoutine(config, routine);
    if (result.failed) fail("The routine run failed — see the companion log.");
    if (!result.message) {
      out({ ok: true, skipped: true });
      return;
    }
    if (!values.dry) {
      await postHouseholdMessage(config, result.message);
    }
    out({ ok: true, message: result.message, posted: !values.dry });
    return;
  }

  fail("Pass one of --get / --enable / --disable / --toggle-routine / --set-auto / --run-now.");
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
