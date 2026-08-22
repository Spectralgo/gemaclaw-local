const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  shell,
} = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * GemaClaw Local.app — a menu-bar shell around the unchanged CLI poller.
 * The tray owns the app (LSUIElement, no Dock icon); the window is for
 * pairing and status. All mutable state lives in ~/.gemaclaw exactly as
 * with `npm start`, so the app and the CLI are interchangeable.
 *
 * Adapted from boop-agent's electron shell (MIT).
 */

const isMac = process.platform === "darwin";
const productName = "GemaClaw Local";
const LOG_LIMIT = 400;

let tray;
let mainWindow;
let pollerProcess;
let pairProcess;
let doctorProcess;
let quitting = false;
let intentionalStop = false;
let stopTimer;
let pendingPrefill;

const status = {
  // unpaired | stopped | starting | idle | task | reconnecting | error
  state: "unpaired",
  serverUrl: "",
  runtime: "",
  model: "",
  taskId: "",
  taskPrompt: "",
  channels: { telegram: false, whatsapp: false },
  configPath: "",
  lastMessage: "",
  /** data: URL of the current WhatsApp link QR, or "" when none pending. */
  whatsappQr: "",
};
const logLines = [];

function appRoot() {
  return path.resolve(__dirname, "..");
}

function configDir() {
  return process.env.GEMACLAW_HOME || path.join(os.homedir(), ".gemaclaw");
}

function configPath() {
  return path.join(configDir(), "config.json");
}

function readConfig() {
  try {
    const value = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (
      value &&
      typeof value === "object" &&
      typeof value.serverUrl === "string" &&
      typeof value.companionToken === "string" &&
      (value.runtime === "claude" || value.runtime === "codex")
    ) {
      return value;
    }
  } catch {
    // Missing or unreadable config simply means "unpaired".
  }
  return null;
}

function refreshFromConfig() {
  const config = readConfig();
  status.configPath = configPath();
  if (!config) {
    status.state = pollerProcess ? status.state : "unpaired";
    status.serverUrl = "";
    status.runtime = "";
    status.model = "";
    status.channels = { telegram: false, whatsapp: false };
    return null;
  }
  status.serverUrl = config.serverUrl;
  status.runtime = config.runtime;
  status.model =
    config.model || (config.runtime === "claude" ? "claude-sonnet-4-6" : "gpt-5.5");
  status.channels = {
    telegram: Boolean(config.channels?.telegram?.botToken),
    whatsapp: Boolean(config.channels?.whatsapp?.enabled),
  };
  if (status.state === "unpaired") status.state = "stopped";
  return config;
}

// ---------------------------------------------------------------------------
// Child process plumbing — an ELECTRON_RUN_AS_NODE shim stands in for node,
// and PATH gains the places `claude` / `codex` normally live so the runtime
// adapters can spawn them from a Dock-launched (login-shell-less) app.
// ---------------------------------------------------------------------------

function writeNodeShim() {
  const shimDir = path.join(app.getPath("userData"), "bin");
  fs.mkdirSync(shimDir, { recursive: true });
  const shim = path.join(shimDir, "node");
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`,
    { mode: 0o755 },
  );
  fs.chmodSync(shim, 0o755);
  return { dir: shimDir, cmd: shim };
}

function childEnv() {
  const shim = writeNodeShim();
  const cliPaths = [
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const env = {
    ...process.env,
    GEMACLAW_DESKTOP: "1",
    FORCE_COLOR: "0",
    PATH: [shim.dir, ...cliPaths, process.env.PATH || ""]
      .filter(Boolean)
      .join(path.delimiter),
  };
  // The cmux/dev shells sometimes leak a --require preload that breaks
  // spawned node processes; the app must never inherit it.
  delete env.NODE_OPTIONS;
  return env;
}

function tsxCli() {
  return path.join(appRoot(), "node_modules", "tsx", "dist", "cli.mjs");
}

// ---------------------------------------------------------------------------
// Status out of log lines — the poller's own output is the contract.
// ---------------------------------------------------------------------------

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function pushLog(line) {
  logLines.push(line);
  if (logLines.length > LOG_LIMIT) logLines.shift();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("gemaclaw-log", line);
  }
}

function ingestLine(rawLine) {
  const line = stripAnsi(rawLine).trimEnd();
  if (!line.trim()) return;

  // WhatsApp link QR: render natively instead of dumping the payload/ASCII
  // into the log panel.
  const qrMatch = line.match(/^\[whatsapp\] qr (.+)$/);
  if (qrMatch) {
    pushLog("[whatsapp] pairing QR ready — scan it from this window");
    require("qrcode")
      .toDataURL(qrMatch[1], { margin: 1, width: 360 })
      .then((dataUrl) => setStatus({ whatsappQr: dataUrl }))
      .catch(() => undefined);
    return;
  }
  pushLog(line);

  const next = { lastMessage: line.trim() };
  if (
    /\[whatsapp\] linked as|\[whatsapp\] connection closed|\[whatsapp\] this device was unlinked/.test(
      line,
    )
  ) {
    next.whatsappQr = "";
  }
  if (/your computer is Gema's brain/.test(line)) next.state = "idle";
  const taskMatch = line.match(/\[gemaclaw\] task (\S+): "(.*)"$/);
  if (taskMatch) {
    next.state = "task";
    next.taskId = taskMatch[1];
    next.taskPrompt = taskMatch[2];
  }
  if (/another runner claimed it first/.test(line)) {
    next.state = "idle";
    next.taskId = "";
    next.taskPrompt = "";
  }
  const doneMatch = line.match(/task (\S+) finished in (\d+)s/);
  if (doneMatch) {
    next.state = "idle";
    next.taskId = "";
    next.taskPrompt = "";
  }
  if (/poll failed \(retrying/.test(line)) next.state = "reconnecting";
  if (/rejected this companion's token/.test(line)) next.state = "unpaired";
  if (/config is missing or invalid/.test(line)) next.state = "unpaired";
  if (/^fatal\b/.test(line)) next.state = "error";

  setStatus(next);
}

function pipeOutput(stream, shouldIngest) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      if (shouldIngest()) ingestLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  });
}

function setStatus(partial) {
  Object.assign(status, partial);
  updateTray();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("gemaclaw-status", statusPayload());
  }
}

function statusPayload() {
  return { ...status, running: Boolean(pollerProcess) };
}

// ---------------------------------------------------------------------------
// Poller lifecycle — SIGINT first so the poller drains exactly like Ctrl-C
// in the terminal (a claimed task is left to the server watchdog).
// ---------------------------------------------------------------------------

function startPoller() {
  if (pollerProcess) return;
  if (!refreshFromConfig()) {
    setStatus({ state: "unpaired" });
    showWindow();
    return;
  }

  intentionalStop = false;
  setStatus({
    state: "starting",
    taskId: "",
    taskPrompt: "",
    lastMessage: "",
    whatsappQr: "",
  });

  const child = spawn(
    writeNodeShim().cmd,
    [tsxCli(), path.join(appRoot(), "server", "main.ts")],
    { cwd: appRoot(), env: childEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
  pollerProcess = child;

  pipeOutput(child.stdout, () => pollerProcess === child);
  pipeOutput(child.stderr, () => pollerProcess === child);
  child.on("error", (error) => {
    if (pollerProcess !== child) return;
    pollerProcess = undefined;
    setStatus({ state: "error", lastMessage: error.message });
  });
  child.on("exit", (code) => {
    if (pollerProcess !== child) return;
    pollerProcess = undefined;
    clearTimeout(stopTimer);
    if (quitting || intentionalStop) {
      setStatus({
        state: refreshFromConfig() ? "stopped" : "unpaired",
        whatsappQr: "",
      });
      return;
    }
    if (status.state === "unpaired") {
      // Token rejected or config invalid — the pairing screen is next.
      showWindow();
      setStatus({ whatsappQr: "" });
      return;
    }
    setStatus({
      state: code === 0 ? "stopped" : "error",
      whatsappQr: "", // a dead child's QR can never be scanned
      lastMessage:
        code === 0 ? "Companion stopped." : `Companion exited with code ${code}`,
    });
  });
}

function stopPoller() {
  const child = pollerProcess;
  if (!child) {
    setStatus({ state: refreshFromConfig() ? "stopped" : "unpaired" });
    return;
  }
  intentionalStop = true;
  setStatus({
    lastMessage: "Stopping — letting the companion finish up.",
    whatsappQr: "",
  });
  child.kill("SIGINT");
  clearTimeout(stopTimer);
  stopTimer = setTimeout(() => {
    if (pollerProcess === child) child.kill("SIGKILL");
  }, 8000);
}

function restartPoller() {
  if (!pollerProcess) {
    startPoller();
    return;
  }
  const child = pollerProcess;
  stopPoller();
  const poll = setInterval(() => {
    if (pollerProcess === child) return;
    clearInterval(poll);
    startPoller();
  }, 250);
}

// ---------------------------------------------------------------------------
// Pairing — delegates to scripts/pair.ts so the app and CLI share one path.
// ---------------------------------------------------------------------------

function runPair(fields) {
  return new Promise((resolve) => {
    if (pairProcess) {
      resolve({ ok: false, error: "Pairing is already in progress." });
      return;
    }
    const args = [
      tsxCli(),
      path.join(appRoot(), "scripts", "pair.ts"),
      "--server",
      fields.serverUrl || "",
      "--code",
      fields.code || "",
      "--runtime",
      fields.runtime || "claude",
    ];
    if (fields.deviceName) args.push("--name", fields.deviceName);
    if (fields.model) args.push("--model", fields.model);
    if (fields.telegramToken) args.push("--telegram-token", fields.telegramToken);
    if (fields.whatsapp) args.push("--whatsapp");

    const child = spawn(writeNodeShim().cmd, args, {
      cwd: appRoot(),
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    pairProcess = child;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const finish = (result) => {
      pairProcess = undefined;
      if (result.ok) {
        refreshFromConfig();
        setStatus({ lastMessage: "Paired." });
        // Re-pairing while running must swap to the NEW config — a plain
        // start would no-op and leave the old poller on the old server.
        if (pollerProcess) {
          restartPoller();
        } else {
          startPoller();
        }
        // First-run safety net: a missing/signed-out runtime should surface
        // NOW, not on the first approved task. Probe-only, so it never
        // fakes companion liveness.
        runDoctor()
          .then((doctor) => {
            pushLog("── post-pair health check ─────────────");
            for (const line of doctor.output.split("\n")) pushLog(line);
          })
          .catch(() => undefined);
      }
      resolve(result);
    };
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("exit", () => {
      const jsonLine = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      if (!jsonLine) {
        finish({
          ok: false,
          error: stderr.trim() || stdout.trim() || "Pairing did not return a result.",
        });
        return;
      }
      try {
        finish(JSON.parse(jsonLine));
      } catch (error) {
        finish({ ok: false, error: String(error) });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Doctor — the CLI health check, surfaced in the window.
// ---------------------------------------------------------------------------

function runDoctor() {
  return new Promise((resolve) => {
    if (doctorProcess) {
      resolve({ ok: false, output: "A health check is already running." });
      return;
    }
    const child = spawn(
      writeNodeShim().cmd,
      [tsxCli(), path.join(appRoot(), "scripts", "doctor.ts")],
      { cwd: appRoot(), env: childEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    doctorProcess = child;
    let output = "";
    const collect = (chunk) => {
      output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const finish = (ok) => {
      doctorProcess = undefined;
      resolve({ ok, output: stripAnsi(output).trimEnd() });
    };
    child.on("error", (error) => {
      output += `\n${error.message}`;
      finish(false);
    });
    child.on("exit", (code) => finish(code === 0));
  });
}

// ---------------------------------------------------------------------------
// Deep links — gemaclaw://pair?server=…&code=… prefills the pairing form,
// so Gema's settings card can hand off with zero typing.
// ---------------------------------------------------------------------------

function handleDeepLink(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }
  if (url.protocol !== "gemaclaw:") return;
  const action = url.hostname || url.pathname.replace(/^\/+/, "");
  if (action !== "pair") return;
  const prefill = {
    serverUrl: url.searchParams.get("server") || "",
    code: (url.searchParams.get("code") || "").toUpperCase(),
  };
  pendingPrefill = prefill;
  if (app.isReady()) {
    showWindow();
    deliverPrefill();
  }
  // Cold-start deep links wait: whenReady triggers delivery.
}

// Delivery is pull-based to dodge every push-vs-listener race: main only
// pings "a prefill is waiting" (idempotent, retried briefly); the renderer
// pulls the payload via gemaclaw:pending-prefill, which clears it. The
// renderer's init() also pulls once, covering pings that fire before its
// listeners exist.
let prefillPingTimer;

function deliverPrefill() {
  clearInterval(prefillPingTimer);
  let attempts = 0;
  const ping = () => {
    if (!pendingPrefill || attempts >= 20) {
      clearInterval(prefillPingTimer);
      return;
    }
    attempts += 1;
    if (mainWindow && !mainWindow.webContents.isLoading()) {
      mainWindow.webContents.send("gemaclaw-prefill-available");
    }
  };
  ping();
  prefillPingTimer = setInterval(ping, 300);
}

// ---------------------------------------------------------------------------
// Tray + window
// ---------------------------------------------------------------------------

const STATE_LABELS = {
  unpaired: "Not paired",
  stopped: "Stopped",
  starting: "Starting…",
  idle: "Watching for deep tasks",
  task: "Running a task",
  reconnecting: "Reconnecting…",
  error: "Error",
};

const STATE_DOTS = {
  unpaired: "◌",
  stopped: "◌",
  starting: "◔",
  idle: "●",
  task: "◉",
  reconnecting: "◔",
  error: "○",
};

function trayIcon() {
  const candidates = [
    path.join(appRoot(), "assets", "trayTemplate.png"),
    path.join(appRoot(), "assets", "trayTemplate@2x.png"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) return nativeImage.createEmpty();
  const image = nativeImage.createFromPath(found);
  image.setTemplateImage(true);
  return image;
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`${productName} — ${STATE_LABELS[status.state] || status.state}`);
  // A short glyph next to the icon when something needs a glance.
  tray.setTitle(
    status.state === "task"
      ? "…"
      : status.state === "reconnecting" || status.state === "error"
        ? "!"
        : "",
  );
  const template = [
    { label: `${STATE_DOTS[status.state] || ""} ${STATE_LABELS[status.state] || status.state}`, enabled: false },
    ...(status.state === "task" && status.taskPrompt
      ? [{ label: `“${status.taskPrompt.slice(0, 48)}”`, enabled: false }]
      : []),
    ...(status.serverUrl
      ? [{ label: `${status.runtime} · ${new URL(status.serverUrl).host}`, enabled: false }]
      : []),
    { type: "separator" },
    { label: "Open GemaClaw Local", click: showWindow },
    { type: "separator" },
    {
      label: "Start",
      enabled: !pollerProcess && status.state !== "unpaired",
      click: startPoller,
    },
    { label: "Restart", enabled: Boolean(pollerProcess), click: restartPoller },
    { label: "Stop", enabled: Boolean(pollerProcess), click: stopPoller },
    { type: "separator" },
    {
      label: "Launch at Login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { label: "Open Config Folder", click: () => shell.openPath(configDir()) },
    { type: "separator" },
    { label: `Quit ${productName}`, click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 560,
    minWidth: 520,
    minHeight: 440,
    title: productName,
    show: false,
    backgroundColor: "#faf6ef",
    titleBarStyle: isMac ? "hiddenInset" : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      shell.openExternal(url).catch(() => undefined);
    }
    return { action: "deny" };
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("close", (event) => {
    // Menu-bar app: closing the window hides it, quitting is in the tray.
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  mainWindow.loadFile(path.join(__dirname, "status.html")).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle("gemaclaw:get-status", () => statusPayload());
ipcMain.handle("gemaclaw:get-logs", () => [...logLines]);
ipcMain.handle("gemaclaw:start", () => {
  startPoller();
  return statusPayload();
});
ipcMain.handle("gemaclaw:stop", () => {
  stopPoller();
  return statusPayload();
});
ipcMain.handle("gemaclaw:restart", () => {
  restartPoller();
  return statusPayload();
});
ipcMain.handle("gemaclaw:pair", (_event, fields) => runPair(fields || {}));
ipcMain.handle("gemaclaw:pending-prefill", () => {
  const prefill = pendingPrefill;
  pendingPrefill = undefined;
  return prefill || null;
});
ipcMain.handle("gemaclaw:doctor", () => runDoctor());
ipcMain.handle("gemaclaw:open-config", () => shell.openPath(configDir()));
ipcMain.handle("gemaclaw:default-device-name", () =>
  os.hostname().replace(/\.local$/, ""),
);

if (!app.requestSingleInstanceLock()) {
  // A losing instance must do nothing beyond quitting — registering
  // handlers or reaching whenReady would transiently double the tray.
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });
  app.setAsDefaultProtocolClient("gemaclaw");

  app.whenReady().then(() => {
    if (isMac && app.dock) app.dock.hide();
    tray = new Tray(trayIcon());
    tray.on("click", () => {
      // Left-click opens the menu too — predictable for a status item.
      tray.popUpContextMenu();
    });

    refreshFromConfig();
    updateTray();
    if (readConfig()) {
      startPoller();
    } else {
      showWindow();
      setStatus({ state: "unpaired" });
    }
    if (pendingPrefill) {
      showWindow();
      deliverPrefill();
    }
  });

  app.on("before-quit", () => {
    quitting = true;
    clearTimeout(stopTimer);
    clearInterval(prefillPingTimer);
    if (pollerProcess) {
      intentionalStop = true;
      pollerProcess.kill("SIGINT");
    }
  });

  app.on("window-all-closed", () => {
    // Tray app: stay alive with no windows.
  });
}
