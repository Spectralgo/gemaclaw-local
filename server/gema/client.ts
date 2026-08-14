import type { GemaLocalConfig } from "../config.js";

/**
 * HTTP client for the two Gema surfaces the companion talks to:
 *
 * 1. `/gemaclaw/companion/*` — pair / poll / claim, authenticated by the
 *    long-lived companion token from pairing.
 * 2. `/gemaclaw/:actionId/*` — the capability broker, authenticated by the
 *    per-task lease token returned by claim. Everything the agent can do
 *    flows through here; writes are approval-gated server-side.
 */

export interface PendingTask {
  actionId: string;
  prompt: string;
  createdAt?: number;
}

export interface ClaimedTask {
  actionId: string;
  prompt: string;
  leaseToken: string;
  brokerUrl: string;
}

/** Thrown when the companion token is rejected — re-pairing is required. */
export class CompanionAuthError extends Error {
  constructor() {
    super(
      "Gema rejected this companion's token. Re-pair from the household settings (Settings → GemaClaw Local) and run setup again.",
    );
    this.name = "CompanionAuthError";
  }
}

/** Every companion/broker request is bounded — a hung server must never
 * stall the runtime loop or block the poller forever. */
const REQUEST_TIMEOUT_MS = 30_000;

async function postJson(
  url: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON error bodies only cost detail.
  }
  return { status: res.status, json };
}

/** Redeem a pairing code for the companion token. */
export async function pair(
  serverUrl: string,
  code: string,
  deviceName: string,
): Promise<string> {
  const base = serverUrl.replace(/\/+$/, "");
  const { status, json } = await postJson(`${base}/gemaclaw/companion/pair`, {
    code,
    deviceName,
  });
  if (status === 404) {
    throw new Error(
      "This Gema server does not have GemaClaw Local enabled (or the URL is wrong).",
    );
  }
  const token = (json as { token?: unknown } | null)?.token;
  if (status !== 200 || typeof token !== "string") {
    throw new Error(
      "Pairing failed — the code may be wrong or expired. Generate a fresh one in the household settings.",
    );
  }
  return token;
}

/** Heartbeat + list of approved tasks routed to this companion. */
export async function pollTasks(
  config: GemaLocalConfig,
): Promise<PendingTask[]> {
  const { status, json } = await postJson(
    `${config.serverUrl}/gemaclaw/companion/poll`,
    { token: config.companionToken },
  );
  if (status === 403) throw new CompanionAuthError();
  // 404 = flag off or server mid-restart — transient, not an auth verdict.
  if (status !== 200) throw new Error(`poll failed with HTTP ${status}`);
  const tasks = (json as { tasks?: unknown } | null)?.tasks;
  return Array.isArray(tasks) ? (tasks as PendingTask[]) : [];
}

/** Atomically claim one task. `null` means another runner won the race. */
export async function claimTask(
  config: GemaLocalConfig,
  actionId: string,
): Promise<ClaimedTask | null> {
  const { status, json } = await postJson(
    `${config.serverUrl}/gemaclaw/companion/claim`,
    { token: config.companionToken, actionId },
  );
  if (status === 409) return null;
  if (status === 403) throw new CompanionAuthError();
  if (status !== 200) throw new Error(`claim failed with HTTP ${status}`);
  const claimed = json as {
    actionId?: unknown;
    prompt?: unknown;
    leaseToken?: unknown;
    brokerUrl?: unknown;
  } | null;
  if (
    typeof claimed?.actionId !== "string" ||
    typeof claimed.prompt !== "string" ||
    typeof claimed.leaseToken !== "string"
  ) {
    throw new Error("claim returned an unexpected payload");
  }
  const brokerUrl =
    typeof claimed.brokerUrl === "string" && claimed.brokerUrl.length > 0
      ? claimed.brokerUrl.replace(/\/+$/, "")
      : config.serverUrl;
  return {
    actionId: claimed.actionId,
    prompt: claimed.prompt,
    leaseToken: claimed.leaseToken,
    brokerUrl,
  };
}

/** Lease-authenticated call into the capability broker. */
async function broker<T>(
  task: ClaimedTask,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(
    `${task.brokerUrl}/gemaclaw/${task.actionId}${path}`,
    {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-gemaclaw-lease": task.leaseToken,
        ...init?.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    throw new Error(`broker ${path} → ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export async function brokerGet<T>(task: ClaimedTask, path: string): Promise<T> {
  return broker<T>(task, path);
}

export async function brokerPost<T>(
  task: ClaimedTask,
  path: string,
  body: unknown,
): Promise<T> {
  return broker<T>(task, path, { method: "POST", body: JSON.stringify(body) });
}

/**
 * Channel-remote calls (WhatsApp/Telegram asks) — companion-token
 * authenticated, same status mapping as poll/claim: 403 = auth verdict,
 * anything else transient.
 */
async function companionPost<T>(
  config: GemaLocalConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const { status, json } = await postJson(
    `${config.serverUrl}/gemaclaw/companion${path}`,
    { token: config.companionToken, ...body },
  );
  if (status === 403) throw new CompanionAuthError();
  if (status !== 200) throw new Error(`${path} failed with HTTP ${status}`);
  return json as T;
}

/** Bounded household context — what the hosted ask feeds its brain. */
export async function fetchHouseholdContext(
  config: GemaLocalConfig,
): Promise<unknown> {
  const result = await companionPost<{ context?: unknown }>(
    config,
    "/context",
    {},
  );
  return result.context ?? {};
}

/** Grocery proposal via the approval door; null actionId = deduped away. */
export async function proposeFromChannel(
  config: GemaLocalConfig,
  kind: "add_items" | "complete_items",
  items: Array<{ id?: string; name: string; location?: string }>,
): Promise<{ actionId: string | null }> {
  const result = await companionPost<{ actionId?: string | null }>(
    config,
    "/propose",
    { kind, items },
  );
  return { actionId: result.actionId ?? null };
}

/** Post to the household chat as Gema (visible to every member). */
export async function postHouseholdMessage(
  config: GemaLocalConfig,
  text: string,
): Promise<void> {
  await companionPost(config, "/message", { text });
}

/** File a deep task draft — a member approves it in the app, then the
 * companion's own poll/claim loop runs it. */
export async function fileDeepTask(
  config: GemaLocalConfig,
  prompt: string,
): Promise<{ actionId: string }> {
  const result = await companionPost<{ actionId?: string }>(config, "/task", {
    prompt,
  });
  if (typeof result.actionId !== "string") {
    throw new Error("deep task draft returned an unexpected payload");
  }
  return { actionId: result.actionId };
}

/**
 * Report completion. Best-effort by design: the lease may already be dead
 * (budget exhausted, kill switch) and the server watchdog fails stale
 * tasks on its own, so a failed complete must never crash the runner.
 */
export async function completeTask(
  task: ClaimedTask,
  summary: string,
  ok: boolean,
  trace?: Array<{ action: string; note: string }>,
): Promise<boolean> {
  // Bounded idempotent retries: a transient blip must not leave the card
  // on "Running…" until the server watchdog when the work already landed.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await brokerPost(task, "/complete", { summary, ok, trace });
      return true;
    } catch (err) {
      console.error(
        `[gemaclaw] complete attempt ${attempt}/3 failed for ${task.actionId}:`,
        err,
      );
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  return false;
}
