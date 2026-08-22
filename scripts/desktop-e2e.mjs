import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

/**
 * Desktop E2E: drives the Electron app against a local stub Gema server.
 * Proves the pairing form → status view → stop path, including the real
 * IPC → scripts/pair.ts → ~/.gemaclaw config write → poller lifecycle.
 *
 *   node scripts/stub-gema-server.mjs &   # or any /gemaclaw/companion stub
 *   node scripts/desktop-e2e.mjs <artifact-dir> [stub-url]
 */

const artifactDir = process.argv[2] || mkdtempSync(path.join(os.tmpdir(), "gemaclaw-e2e-"));
const stubUrl = process.argv[3] || "http://127.0.0.1:4799";
const appRoot = path.resolve(new URL("..", import.meta.url).pathname);
const ghome = mkdtempSync(path.join(os.tmpdir(), "gemaclaw-home-"));

const shot = (page, name) =>
  page.screenshot({ path: path.join(artifactDir, name) });

function fail(message) {
  console.error(`E2E FAIL: ${message}`);
  process.exit(1);
}

const app = await electron.launch({
  args: [appRoot],
  env: {
    ...process.env,
    NODE_OPTIONS: "",
    GEMACLAW_HOME: ghome,
  },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector("#view-pair:not(.hidden)", { timeout: 15000 });
  await shot(page, "01-pairing-form.png");

  await page.fill("#f-server", stubUrl);
  await page.fill("#f-code", "abcd1234");
  await page.click("#pair-submit");

  await page.waitForSelector("#view-status:not(.hidden)", { timeout: 20000 });
  await page.waitForFunction(
    () => document.getElementById("s-label")?.textContent?.includes("Watching"),
    { timeout: 30000 },
  );
  await page.waitForFunction(
    () => document.getElementById("log")?.textContent?.includes("your computer is Gema's brain"),
    { timeout: 15000 },
  );
  await shot(page, "02-status-idle.png");

  const server = await page.textContent("#s-server");
  if (!server?.includes("127.0.0.1:4799")) fail(`server shows "${server}"`);
  const config = JSON.parse(readFileSync(path.join(ghome, "config.json"), "utf8"));
  if (config.companionToken !== "stub-companion-token") fail("config token mismatch");

  // Auto mode: enabling seeds the default routines and persists to config.
  await page.check("#auto-enabled");
  // The meta line flips to the runs-today counter only after the enable
  // round-trips through auto-config (a tsx spawn) and re-renders.
  await page.waitForFunction(
    () =>
      document
        .getElementById("auto-meta")
        ?.textContent?.includes("automatic runs today"),
    { timeout: 30000 },
  );
  await page.waitForFunction(
    () => document.querySelectorAll("#auto-routines .routine-row").length >= 2,
    { timeout: 15000 },
  );
  const autoConfig = JSON.parse(
    readFileSync(path.join(ghome, "config.json"), "utf8"),
  );
  if (autoConfig.auto?.enabled !== true) fail("auto.enabled not persisted");
  if ((autoConfig.auto?.routines?.length ?? 0) < 2)
    fail("default routines not seeded");
  await shot(page, "07-auto-mode.png");

  // Doctor: config + server/pairing must pass against the stub.
  await page.click("#b-doctor");
  await page.waitForFunction(
    () => document.getElementById("log")?.textContent?.includes("health check"),
    { timeout: 30000 },
  );
  await page.waitForFunction(
    () => /✓ config/.test(document.getElementById("log")?.textContent || ""),
    { timeout: 30000 },
  );
  await shot(page, "04-doctor.png");

  // WhatsApp QR card: drive the renderer with a synthetic status push.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.send("gemaclaw-status", {
      state: "idle",
      serverUrl: "http://127.0.0.1:4799",
      runtime: "claude",
      model: "claude-sonnet-4-6",
      channels: { telegram: false, whatsapp: true },
      whatsappQr:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      running: true,
      lastMessage: "",
    });
  });
  await page.waitForSelector("#qr-card:not(.hidden)", { timeout: 5000 });
  await shot(page, "05-whatsapp-qr.png");

  await page.click("#b-stop");
  await page.waitForFunction(
    () => document.getElementById("s-label")?.textContent === "Stopped",
    { timeout: 15000 },
  );
  await shot(page, "03-stopped.png");

  const startEnabled = await page.isEnabled("#b-start");
  if (!startEnabled) fail("Start button not re-enabled after stop");

  // Deep link: gemaclaw://pair prefills the pairing form.
  await app.evaluate(({ app: electronApp }) => {
    electronApp.emit(
      "open-url",
      { preventDefault() {} },
      "gemaclaw://pair?server=https%3A%2F%2Fpr-999.gema.spectralgo.com&code=zyxw9876",
    );
  });
  await page.waitForSelector("#view-pair:not(.hidden)", { timeout: 5000 });
  const preServer = await page.inputValue("#f-server");
  const preCode = await page.inputValue("#f-code");
  if (preServer !== "https://pr-999.gema.spectralgo.com")
    fail(`deep link server prefill got "${preServer}"`);
  if (preCode !== "ZYXW9876") fail(`deep link code prefill got "${preCode}"`);
  // Security posture: the target host is surfaced, and focus must NOT be
  // on the submit button (one keystroke must never complete a pairing).
  const warning = await page.textContent("#pair-warning");
  if (!warning?.includes("pr-999.gema.spectralgo.com"))
    fail(`deep link warning missing host: "${warning}"`);
  const focused = await page.evaluate(() => document.activeElement?.id || "");
  if (focused === "pair-submit") fail("deep link focused the Pair button");
  await shot(page, "06-deeplink-prefill.png");

  console.log(`E2E PASS — screenshots in ${artifactDir}`);
} finally {
  await app.close().catch(() => undefined);
}
if (!existsSync(path.join(artifactDir, "03-stopped.png"))) fail("missing final screenshot");
