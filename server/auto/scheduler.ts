import fs from "node:fs";
import path from "node:path";
import { runProactiveRoutine } from "../channels/ask-runner.js";
import {
  type AutoConfig,
  type AutoRoutine,
  configDir,
  type GemaLocalConfig,
  loadConfig,
} from "../config.js";
import { postHouseholdMessage } from "../gema/client.js";

/**
 * Auto mode — Gema initiates. Routines fire on a local-time schedule and
 * run on the subscription runtime; the result is a short proactive note
 * in the household chat (or silence). Writes stay approval-gated.
 *
 * Discipline, in order: master switch → quiet hours → daily cap → due.
 * A slot missed while the computer slept still runs within its grace
 * window; after that it is skipped, never deferred into the night.
 */

export const DEFAULT_MAX_RUNS_PER_DAY = 6;
/** A due slot stays runnable this long after its scheduled time. */
export const SLOT_GRACE_MS = 4 * 60 * 60 * 1000;

export const DEFAULT_ROUTINES: AutoRoutine[] = [
  {
    id: "morning-brief",
    name: "Morning brief",
    prompt:
      "Give the household a short morning brief: what's on today's calendar, anything notable on the shopping list, and one genuinely helpful suggestion if there is one. If the day is empty and the list is quiet, skip.",
    schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: "08:00" },
    enabled: true,
  },
  {
    id: "week-planner",
    name: "Sunday week planner",
    prompt:
      "Look at the coming week: calendar events and the state of the shopping list. Suggest a simple plan — what to cook or prepare, and what the household may want to buy. If additions to the list are obviously needed, propose them with the tools.",
    schedule: { days: [0], time: "18:00" },
    enabled: true,
  },
];

interface AutoState {
  /** Per-routine: epoch ms of the last slot that ran (the SLOT time). */
  lastSlotRun: Record<string, number>;
  /** Local calendar day (YYYY-MM-DD) the counter belongs to. */
  runsDay: string;
  runsToday: number;
}

function statePath(): string {
  return path.join(configDir(), "auto-state.json");
}

export function loadAutoState(): AutoState {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    if (raw && typeof raw === "object") {
      return {
        lastSlotRun:
          typeof raw.lastSlotRun === "object" && raw.lastSlotRun
            ? raw.lastSlotRun
            : {},
        runsDay: typeof raw.runsDay === "string" ? raw.runsDay : "",
        runsToday: typeof raw.runsToday === "number" ? raw.runsToday : 0,
      };
    }
  } catch {
    // Missing state = fresh install.
  }
  return { lastSlotRun: {}, runsDay: "", runsToday: 0 };
}

export function saveAutoState(state: AutoState): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
}

function localDayKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function parseHm(value: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return { h, m };
}

export function inQuietHours(
  quiet: AutoConfig["quietHours"],
  now: Date,
): boolean {
  if (!quiet) return false;
  const start = parseHm(quiet.start);
  const end = parseHm(quiet.end);
  if (!start || !end) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const startM = start.h * 60 + start.m;
  const endM = end.h * 60 + end.m;
  if (startM === endM) return false;
  // A window may wrap midnight (22:00 → 07:30).
  return startM < endM
    ? minutes >= startM && minutes < endM
    : minutes >= startM || minutes < endM;
}

/** The most recent scheduled slot at-or-before `now`, or null. */
export function latestSlot(routine: AutoRoutine, now: Date): Date | null {
  const hm = parseHm(routine.schedule.time);
  if (!hm || routine.schedule.days.length === 0) return null;
  for (let back = 0; back < 8; back++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    if (!routine.schedule.days.includes(day.getDay())) continue;
    const slot = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      hm.h,
      hm.m,
    );
    if (slot.getTime() <= now.getTime()) return slot;
  }
  return null;
}

/** The next scheduled slot strictly after `now`, or null. */
export function nextSlot(routine: AutoRoutine, now: Date): Date | null {
  const hm = parseHm(routine.schedule.time);
  if (!hm || routine.schedule.days.length === 0) return null;
  for (let ahead = 0; ahead < 8; ahead++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
    if (!routine.schedule.days.includes(day.getDay())) continue;
    const slot = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      hm.h,
      hm.m,
    );
    if (slot.getTime() > now.getTime()) return slot;
  }
  return null;
}

/** A routine is due when its latest slot is inside the grace window and
 * has not run yet. Pure — state is passed in. */
export function isDue(
  routine: AutoRoutine,
  now: Date,
  state: AutoState,
): Date | null {
  if (!routine.enabled) return null;
  const slot = latestSlot(routine, now);
  if (!slot) return null;
  if (now.getTime() - slot.getTime() > SLOT_GRACE_MS) return null;
  if ((state.lastSlotRun[routine.id] ?? 0) >= slot.getTime()) return null;
  return slot;
}

export interface AutoTickDeps {
  runRoutine?: typeof runProactiveRoutine;
  postMessage?: typeof postHouseholdMessage;
  loadState?: typeof loadAutoState;
  saveState?: typeof saveAutoState;
  /** Fresh config each tick so app-side edits apply without a restart. */
  readConfig?: () => GemaLocalConfig;
  log?: (line: string) => void;
  now?: () => Date;
}

/**
 * One scheduler tick: run AT MOST one due routine (the poll loop calls
 * this every cycle, so backlogs drain quickly without hogging the lane).
 * Returns true when a routine ran.
 */
export async function autoTick(deps: AutoTickDeps = {}): Promise<boolean> {
  const log = deps.log ?? console.log;
  const now = (deps.now ?? (() => new Date()))();
  let config: GemaLocalConfig;
  try {
    config = (deps.readConfig ?? loadConfig)();
  } catch {
    return false; // unpaired — nothing to do
  }
  const auto = config.auto;
  if (!auto?.enabled || auto.routines.length === 0) return false;
  if (inQuietHours(auto.quietHours, now)) return false;

  const loadState = deps.loadState ?? loadAutoState;
  const saveState = deps.saveState ?? saveAutoState;
  const state = loadState();
  const dayKey = localDayKey(now);
  if (state.runsDay !== dayKey) {
    state.runsDay = dayKey;
    state.runsToday = 0;
  }
  const cap = auto.maxRunsPerDay ?? DEFAULT_MAX_RUNS_PER_DAY;
  if (state.runsToday >= cap) return false;

  for (const routine of auto.routines) {
    const slot = isDue(routine, now, state);
    if (!slot) continue;

    // Claim the slot BEFORE running — a crash mid-run must not replay the
    // routine every restart.
    state.lastSlotRun[routine.id] = slot.getTime();
    state.runsToday += 1;
    saveState(state);

    log(`[auto] routine "${routine.name}" starting (slot ${slot.toTimeString().slice(0, 5)})`);
    const result = await (deps.runRoutine ?? runProactiveRoutine)(
      config,
      routine,
    );
    if (result.failed) {
      log(`[auto] routine "${routine.name}" failed — will try again at its next slot`);
      return true;
    }
    if (!result.message) {
      log(`[auto] routine "${routine.name}" had nothing to say (skipped)`);
      return true;
    }
    try {
      await (deps.postMessage ?? postHouseholdMessage)(config, result.message);
      log(`[auto] routine "${routine.name}" posted to the household chat`);
    } catch (err) {
      log(`[auto] routine "${routine.name}" post failed: ${String(err)}`);
    }
    return true;
  }
  return false;
}
