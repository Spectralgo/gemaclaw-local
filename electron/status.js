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

function showView(state) {
  const pairing = state === "unpaired";
  $("view-pair").classList.toggle("hidden", !pairing);
  $("view-status").classList.toggle("hidden", pairing);
}

function renderStatus(status) {
  currentState = status.state;
  showView(status.state);
  if (status.state === "unpaired") return;

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

async function init() {
  $("f-name").value = await window.gemaclaw.defaultDeviceName();
  renderStatus(await window.gemaclaw.getStatus());
  const lines = await window.gemaclaw.getLogs();
  $("log").textContent = lines.join("\n");
  $("log").scrollTop = $("log").scrollHeight;

  window.gemaclaw.onStatus(renderStatus);
  window.gemaclaw.onLog(appendLog);

  $("b-start").addEventListener("click", () => window.gemaclaw.start());
  $("b-stop").addEventListener("click", () => window.gemaclaw.stop());
  $("b-restart").addEventListener("click", () => window.gemaclaw.restart());
  $("b-config").addEventListener("click", () => window.gemaclaw.openConfig());

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
      }
      // On success main flips state to stopped/starting and pushes a
      // status update, which swaps the view — nothing else to do here.
    } finally {
      submit.disabled = false;
      submit.textContent = "Pair";
    }
  });
}

init().catch((err) => {
  document.body.textContent = `GemaClaw Local failed to start its window: ${err}`;
});
