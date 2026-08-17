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

  await page.click("#b-stop");
  await page.waitForFunction(
    () => document.getElementById("s-label")?.textContent === "Stopped",
    { timeout: 15000 },
  );
  await shot(page, "03-stopped.png");

  const startEnabled = await page.isEnabled("#b-start");
  if (!startEnabled) fail("Start button not re-enabled after stop");

  console.log(`E2E PASS — screenshots in ${artifactDir}`);
} finally {
  await app.close().catch(() => undefined);
}
if (!existsSync(path.join(artifactDir, "03-stopped.png"))) fail("missing final screenshot");
