/* Renderer for GemaClaw Local.app — swaps between the pairing form and the
 * status card, and tails the companion log. All state comes from main via
 * the preload bridge; this file renders and forwards clicks. */

const $ = (id) => document.getElementById(id);

const STATE_LABELS = {
  unpaired: "Not paired",
  stopped: "Stopped",
  starting: "Starting…",
  idle: "Watching for deep tasks",
  task: "Running a task",
  reconnecting: "Reconnecting…",
  error: "Something went wrong",
};

let currentState = "";
// Set by a gemaclaw://pair deep link: keep the pairing form up (prefilled)
// even while the poller is running, until the user pairs or navigates.
let forcePairView = false;

function showView(state) {
  const pairing = forcePairView || state === "unpaired";
  $("view-pair").classList.toggle("hidden", !pairing);
  $("view-status").classList.toggle("hidden", pairing);
}

function renderStatus(status) {
  currentState = status.state;
  showView(status.state);

  const qrCard = $("qr-card");
  if (status.whatsappQr) {
    $("qr-img").src = status.whatsappQr;
    qrCard.classList.remove("hidden");
  } else {
    qrCard.classList.add("hidden");
    $("qr-img").removeAttribute("src");
  }

  if (forcePairView || status.state === "unpaired") return;

  $("s-label").textContent = STATE_LABELS[status.state] || status.state;
  $("s-dot").className = `dot ${status.state}`;

  const task = $("s-task");
  if (status.state === "task" && status.taskPrompt) {
    task.textContent = `“${status.taskPrompt}”`;
    task.classList.remove("hidden");
  } else {
    task.classList.add("hidden");
  }

  $("s-server").textContent = status.serverUrl
    ? new URL(status.serverUrl).host
    : "—";
  $("s-runtime").textContent = status.runtime
    ? `${status.runtime} · ${status.model}`
    : "—";
  const channels = [
    status.channels?.telegram ? "Telegram" : null,
    status.channels?.whatsapp ? "WhatsApp" : null,
  ].filter(Boolean);
  $("s-channels").textContent = channels.length ? channels.join(" + ") : "app only";
  $("s-last").textContent = status.lastMessage || "";

  $("b-start").disabled = status.running;
  $("b-restart").disabled = !status.running;
  $("b-stop").disabled = !status.running;
}

function appendLog(line) {
  const log = $("log");
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
  log.textContent += (log.textContent ? "\n" : "") + line;
  const max = 400;
  const lines = log.textContent.split("\n");
  if (lines.length > max) log.textContent = lines.slice(-max).join("\n");
  if (atBottom) log.scrollTop = log.scrollHeight;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function scheduleLabel(schedule) {
  const days =
    schedule.days.length === 7
      ? "Every day"
      : schedule.days.map((d) => DAY_NAMES[d] || "?").join(", ");
  return `${days} · ${schedule.time}`;
}

function renderAuto(view) {
  if (!view?.ok) return;
  $("auto-enabled").checked = Boolean(view.auto.enabled);
  const list = $("auto-routines");
  list.textContent = "";
  for (const routine of view.auto.routines) {
    const row = document.createElement("div");
    row.className = "routine-row";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = routine.enabled;
    toggle.disabled = !view.auto.enabled;
    toggle.addEventListener("change", async () => {
      renderAuto(await window.gemaclaw.autoToggleRoutine(routine.id));
    });

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = routine.name;

    const when = document.createElement("span");
    when.className = "when";
    const next = view.nextRuns?.[routine.id];
    when.textContent =
      scheduleLabel(routine.schedule) +
      (next ? ` · next ${new Date(next).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "");

    const run = document.createElement("button");
    run.type = "button";
    run.textContent = "Run now";
    run.addEventListener("click", async () => {
      run.disabled = true;
      run.textContent = "Running…";
      try {
        const result = await window.gemaclaw.autoRunNow(routine.id);
        if (!result.ok) {
          appendLog(`[auto] run failed: ${result.error || "unknown error"}`);
        } else if (result.skipped) {
          appendLog(`[auto] "${routine.name}" had nothing to say (skipped)`);
        } else {
          appendLog(`[auto] "${routine.name}" posted: ${result.message}`);
        }
        $("log").scrollTop = $("log").scrollHeight;
      } finally {
        run.disabled = false;
        run.textContent = "Run now";
      }
    });

    row.append(toggle, name, when, run);
    list.append(row);
  }
  const cap = view.auto.maxRunsPerDay ?? 6;
  $("auto-meta").textContent = view.auto.enabled
    ? `${view.runsToday}/${cap} automatic runs today${view.auto.quietHours ? ` · quiet ${view.auto.quietHours.start}–${view.auto.quietHours.end}` : ""}`
    : "Off — Gema only acts when asked.";
}

async function refreshAuto() {
  renderAuto(await window.gemaclaw.autoGet());
}

async function init() {
  $("f-name").value = await window.gemaclaw.defaultDeviceName();
  renderStatus(await window.gemaclaw.getStatus());
  const lines = await window.gemaclaw.getLogs();
  $("log").textContent = lines.join("\n");
  $("log").scrollTop = $("log").scrollHeight;

  const applyPrefill = (prefill) => {
    forcePairView = true;
    if (prefill.serverUrl) $("f-server").value = prefill.serverUrl;
    if (prefill.code) $("f-code").value = prefill.code;
    showView(currentState);
    $("pair-error").textContent = "";
    // Deep links are attacker-reachable (any web page can navigate to
    // gemaclaw://). Surface the target host and NEVER focus the submit
    // button — pairing must be a deliberate, informed click.
    let host = prefill.serverUrl;
    try {
      host = new URL(prefill.serverUrl).host;
    } catch {}
    const warning = $("pair-warning");
    warning.textContent = host
      ? `This pairing request points at ${host} — continue only if that is your Gema.`
      : "";
    warning.classList.toggle("hidden", !host);
    $("pair-back").classList.toggle("hidden", currentState === "unpaired");
    $("f-code").focus();
  };

  $("pair-back").addEventListener("click", () => {
    forcePairView = false;
    $("pair-warning").classList.add("hidden");
    $("pair-back").classList.add("hidden");
    showView(currentState);
  });

  window.gemaclaw.onStatus(renderStatus);
  window.gemaclaw.onLog(appendLog);
  window.gemaclaw.onPrefill(applyPrefill);
  // Prefills are pull-based: main pings availability (retried), we pull
  // the payload (pulling clears it, so double-apply is impossible).
  const pullPrefill = async () => {
    const queued = await window.gemaclaw.pendingPrefill();
    if (queued) applyPrefill(queued);
  };
  window.gemaclaw.onPrefillAvailable(pullPrefill);

  $("auto-enabled").addEventListener("change", async (event) => {
    renderAuto(await window.gemaclaw.autoEnable(event.target.checked));
  });

  $("b-start").addEventListener("click", () => window.gemaclaw.start());
  $("b-stop").addEventListener("click", () => window.gemaclaw.stop());
  $("b-restart").addEventListener("click", () => window.gemaclaw.restart());
  $("b-config").addEventListener("click", () => window.gemaclaw.openConfig());
  $("b-doctor").addEventListener("click", async () => {
    const button = $("b-doctor");
    button.disabled = true;
    button.textContent = "Checking…";
    try {
      const result = await window.gemaclaw.doctor();
      appendLog("── health check ─────────────────────");
      for (const line of result.output.split("\n")) appendLog(line);
      appendLog(result.ok ? "── all good ──" : "── issues found (fixes above) ──");
      $("log").scrollTop = $("log").scrollHeight;
    } catch (err) {
      appendLog(`── health check failed to run: ${err?.message || err} ──`);
    } finally {
      button.disabled = false;
      button.textContent = "Run health check";
    }
  });

  $("pair-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = $("pair-submit");
    const error = $("pair-error");
    error.textContent = "";
    submit.disabled = true;
    submit.textContent = "Pairing…";
    try {
      const result = await window.gemaclaw.pair({
        serverUrl: $("f-server").value.trim(),
        code: $("f-code").value.trim(),
        deviceName: $("f-name").value.trim(),
        runtime: document.querySelector('input[name="runtime"]:checked').value,
        model: $("f-model").value.trim(),
        telegramToken: $("f-telegram").value.trim(),
        whatsapp: $("f-whatsapp").checked,
      });
      if (!result.ok) {
        error.textContent = result.error || "Pairing failed.";
      } else {
        forcePairView = false;
        $("pair-warning").classList.add("hidden");
        $("pair-back").classList.add("hidden");
        refreshAuto();
      }
      // On success main flips state to stopped/starting and pushes a
      // status update, which swaps the view — nothing else to do here.
    } finally {
      submit.disabled = false;
      submit.textContent = "Pair";
    }
  });

  // Data loads come LAST: every listener above must be live before any
  // slow await (auto-config spawns tsx, ~seconds) — otherwise an early
  // click lands on a deaf form.
  await pullPrefill();
  await refreshAuto();
  // Keep next-run times and the daily counter roughly current.
  setInterval(refreshAuto, 5 * 60 * 1000);
}

init().catch((err) => {
  document.body.textContent = `GemaClaw Local failed to start its window: ${err}`;
});
