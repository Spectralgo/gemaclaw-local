import { describe, expect, it, vi } from "vitest";
import type { AutoRoutine, GemaLocalConfig } from "../config.js";
import {
  autoTick,
  DEFAULT_ROUTINES,
  inQuietHours,
  isDue,
  latestSlot,
  nextSlot,
  SLOT_GRACE_MS,
} from "./scheduler.js";

const at = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi);

// 2026-08-19 is a Wednesday (day 3); 2026-08-23 is a Sunday.
const WED_9AM = at(2026, 8, 19, 9);

const daily8: AutoRoutine = {
  id: "r1",
  name: "Daily",
  prompt: "p",
  schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: "08:00" },
  enabled: true,
};

const config = (auto: GemaLocalConfig["auto"]): GemaLocalConfig => ({
  serverUrl: "http://127.0.0.1:4799",
  companionToken: "tok",
  runtime: "claude",
  auto,
});

const freshState = () => ({ lastSlotRun: {}, runsDay: "", runsToday: 0 });

describe("slots", () => {
  it("latestSlot finds today's slot once the time passed", () => {
    expect(latestSlot(daily8, WED_9AM)?.getHours()).toBe(8);
    expect(latestSlot(daily8, WED_9AM)?.getDate()).toBe(19);
  });

  it("latestSlot rolls back to the previous scheduled day", () => {
    const sundayOnly: AutoRoutine = {
      ...daily8,
      schedule: { days: [0], time: "18:00" },
    };
    const slot = latestSlot(sundayOnly, WED_9AM);
    expect(slot?.getDay()).toBe(0);
    expect(slot?.getDate()).toBe(16); // previous Sunday
  });

  it("nextSlot finds the coming slot across days", () => {
    const sundayOnly: AutoRoutine = {
      ...daily8,
      schedule: { days: [0], time: "18:00" },
    };
    const slot = nextSlot(sundayOnly, WED_9AM);
    expect(slot?.getDay()).toBe(0);
    expect(slot?.getDate()).toBe(23); // coming Sunday
  });

  it("invalid time or empty days yield no slot", () => {
    expect(
      latestSlot({ ...daily8, schedule: { days: [], time: "08:00" } }, WED_9AM),
    ).toBeNull();
    expect(
      nextSlot({ ...daily8, schedule: { days: [1], time: "25:99" } }, WED_9AM),
    ).toBeNull();
  });
});

describe("isDue", () => {
  it("due within the grace window, not after", () => {
    expect(isDue(daily8, WED_9AM, freshState())).not.toBeNull();
    const late = new Date(
      at(2026, 8, 19, 8).getTime() + SLOT_GRACE_MS + 60_000,
    );
    expect(isDue(daily8, late, freshState())).toBeNull();
  });

  it("never due twice for the same slot", () => {
    const slot = at(2026, 8, 19, 8).getTime();
    const state = { ...freshState(), lastSlotRun: { r1: slot } };
    expect(isDue(daily8, WED_9AM, state)).toBeNull();
  });

  it("disabled routines are never due", () => {
    expect(isDue({ ...daily8, enabled: false }, WED_9AM, freshState())).toBeNull();
  });
});

describe("quiet hours", () => {
  it("plain window", () => {
    expect(inQuietHours({ start: "08:30", end: "10:00" }, WED_9AM)).toBe(true);
    expect(inQuietHours({ start: "10:00", end: "11:00" }, WED_9AM)).toBe(false);
  });

  it("midnight-wrapping window", () => {
    const q = { start: "22:00", end: "07:30" };
    expect(inQuietHours(q, at(2026, 8, 19, 23))).toBe(true);
    expect(inQuietHours(q, at(2026, 8, 19, 7))).toBe(true);
    expect(inQuietHours(q, WED_9AM)).toBe(false);
  });
});

describe("autoTick", () => {
  const deps = (overrides: Record<string, unknown> = {}) => {
    const saved: unknown[] = [];
    const posts: string[] = [];
    const base = {
      readConfig: () =>
        config({ enabled: true, routines: [structuredClone(daily8)] }),
      loadState: () => freshState(),
      saveState: (s: unknown) => {
        saved.push(structuredClone(s));
      },
      runRoutine: vi.fn(async () => ({ message: "note" })),
      postMessage: vi.fn(async (_c: unknown, text: string) => {
        posts.push(text);
      }),
      log: () => {},
      now: () => WED_9AM,
      ...overrides,
    };
    return { base, saved, posts };
  };

  it("runs a due routine and posts its note", async () => {
    const { base, saved, posts } = deps();
    await expect(autoTick(base as never)).resolves.toBe(true);
    expect(posts).toEqual(["note"]);
    // Slot claimed BEFORE the run (crash safety).
    expect((saved[0] as { lastSlotRun: Record<string, number> }).lastSlotRun.r1).toBe(
      at(2026, 8, 19, 8).getTime(),
    );
  });

  it("SKIP posts nothing but still consumes the slot", async () => {
    const { base, posts } = deps({ runRoutine: vi.fn(async () => ({})) });
    await expect(autoTick(base as never)).resolves.toBe(true);
    expect(posts).toEqual([]);
  });

  it("master switch off / quiet hours / cap all gate the run", async () => {
    const off = deps({
      readConfig: () => config({ enabled: false, routines: [daily8] }),
    });
    await expect(autoTick(off.base as never)).resolves.toBe(false);

    const quiet = deps({
      readConfig: () =>
        config({
          enabled: true,
          quietHours: { start: "08:30", end: "10:00" },
          routines: [daily8],
        }),
    });
    await expect(autoTick(quiet.base as never)).resolves.toBe(false);

    const capped = deps({
      loadState: () => ({
        lastSlotRun: {},
        runsDay: "2026-08-19",
        runsToday: 6,
      }),
    });
    await expect(autoTick(capped.base as never)).resolves.toBe(false);
  });

  it("unpaired (config throws) is a quiet no-op", async () => {
    const { base } = deps({
      readConfig: () => {
        throw new Error("no config");
      },
    });
    await expect(autoTick(base as never)).resolves.toBe(false);
  });

  it("default routines are sane", () => {
    for (const routine of DEFAULT_ROUTINES) {
      expect(nextSlot(routine, WED_9AM)).not.toBeNull();
    }
  });
});
