import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, _electron as electron } from "playwright-core";

/**
 * LIVE end-to-end proof — no stubs. Drives a real Gema stage's web UI and
 * the desktop app side by side:
 *
 *   sign up → Settings: "Pair a computer" → deep-link the app with the
 *   real code → app pairs + polls → chat: "deep: …" → approve the card →
 *   the APP runs the task on the machine's real Claude login → the
 *   result lands back in chat.
 *
 * Prereqs: the Wazo dev stack running locally with GEMA_LOCAL_BRAIN=true
 * (web + API), and a signed-in `claude` CLI on this machine.
 *
 *   node scripts/desktop-e2e-live.mjs <artifact-dir> \
 *     [web-url=http://localhost:3001] [api-url=http://127.0.0.1:3003] \
 *     [chromium-executable]
 */

const artifactDir =
  process.argv[2] || mkdtempSync(path.join(os.tmpdir(), "gemaclaw-live-"));
const webUrl = process.argv[3] || "http://localhost:3001";
const apiUrl = process.argv[4] || "http://127.0.0.1:3003";
const chromiumPath =
  process.argv[5] ||
  path.join(
    os.homedir(),
    "Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  );
const appRoot = path.resolve(new URL("..", import.meta.url).pathname);
const ghome = mkdtempSync(path.join(os.tmpdir(), "gemaclaw-home-"));
const PROOF_WORD = `PINEAPPLE-${Date.now().toString(36).toUpperCase()}`;

const step = (name) => console.log(`STEP ${name}`);
function fail(message) {
  console.error(`LIVE E2E FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

const browser = await chromium.launch({ executablePath: chromiumPath });
const web = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const app = await electron.launch({
  args: [appRoot],
  env: { ...process.env, NODE_OPTIONS: "", GEMACLAW_HOME: ghome },
});

try {
  // ---- 1. Sign up a fresh account on the real stage -----------------------
  step("signup");
  await web.goto(`${webUrl}/login`);
  await web.getByText("Get Started").first().click();
  await web.getByPlaceholder("Your name").fill("E2E Flo");
  await web.getByPlaceholder("you@example.com").fill(`e2e-${Date.now()}@example.com`);
  await web.getByPlaceholder("••••••••").first().fill("proof-password-1");
  await web.keyboard.press("Enter");
  await web.waitForURL(/\/(list|onboarding|chat)/, { timeout: 30000 });
  await web.screenshot({ path: path.join(artifactDir, "live-01-signed-up.png") });

  // ---- 2. Generate a pairing code in Settings ----------------------------
  step("pairing code");
  await web.goto(`${webUrl}/household`);
  const pairButton = web.getByRole("button", { name: "Pair a computer" });
  await pairButton.scrollIntoViewIfNeeded();
  await pairButton.click();
  const codeEl = web.locator("p.font-mono").first();
  await codeEl.waitFor({ timeout: 20000 });
  const code = (await codeEl.textContent())?.trim() || "";
  if (!/^[A-Z0-9]{8}$/i.test(code)) fail(`pairing code scrape got "${code}"`);
  await web.screenshot({ path: path.join(artifactDir, "live-02-pairing-code.png") });

  // ---- 3. Deep-link the app with the real server + code ------------------
  step("app pair via deep link");
  const appWindow = await app.firstWindow();
  await app.evaluate(({ app: electronApp }, url) => {
    electronApp.emit("open-url", { preventDefault() {} }, url);
  }, `gemaclaw://pair?server=${encodeURIComponent(apiUrl)}&code=${encodeURIComponent(code)}`);
  await appWindow.waitForSelector("#view-pair:not(.hidden)", { timeout: 10000 });
  await appWindow.click("#pair-submit");
  await appWindow.waitForFunction(
    () => document.getElementById("s-label")?.textContent?.includes("Watching"),
    { timeout: 30000 },
  );
  await appWindow.screenshot({ path: path.join(artifactDir, "live-03-app-paired.png") });

  // ---- 4. Settings shows the companion as connected ----------------------
  step("settings shows connected");
  await web.reload();
  await web.waitForTimeout(2000);
  await web.screenshot({ path: path.join(artifactDir, "live-04-settings-connected.png") });

  // ---- 5. File a deep task from chat -------------------------------------
  step("file deep task");
  await web.goto(`${webUrl}/chat`);
  const input = web.getByPlaceholder("Message...");
  await input.waitFor({ timeout: 20000 });
  await input.fill(
    `deep: reply with a one-line summary that contains exactly the word ${PROOF_WORD}`,
  );
  await web.keyboard.press("Enter");
  await web.waitForTimeout(3000);
  // Local alchemy dev churns chat WebSockets — the card exists server-side
  // but the live push can be missed. Reload-and-retry is dev-env armor.
  const runButton = web.getByRole("button", { name: "Run", exact: true }).first();
  let cardSeen = false;
  for (let attempt = 0; attempt < 5 && !cardSeen; attempt++) {
    cardSeen = await runButton
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (!cardSeen) {
      step(`approval card not visible — reload ${attempt + 1}`);
      await web.reload();
      await web.waitForTimeout(3000);
    }
  }
  if (!cardSeen) fail("approval card never appeared (after reload retries)");
  await web.screenshot({ path: path.join(artifactDir, "live-05-approval-card.png") });

  // ---- 6. Approve — the app must claim and run it on real Claude ---------
  step("approve and run on the app");
  await runButton.click();
  await appWindow.waitForFunction(
    () =>
      document.getElementById("log")?.textContent?.includes("[gemaclaw] task "),
    { timeout: 60000 },
  );
  await appWindow.screenshot({ path: path.join(artifactDir, "live-06-app-running.png") });
  await appWindow.waitForFunction(
    () => /task \S+ finished in \d+s/.test(document.getElementById("log")?.textContent || ""),
    { timeout: 300000 },
  );

  // ---- 7. The result lands back in chat ----------------------------------
  step("result in chat");
  let resultSeen = false;
  for (let attempt = 0; attempt < 5 && !resultSeen; attempt++) {
    resultSeen = await web
      .waitForFunction(
        (word) => document.body.innerText.includes(word),
        PROOF_WORD,
        { timeout: 15000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!resultSeen) {
      step(`result not visible — reload ${attempt + 1}`);
      await web.reload();
      await web.waitForTimeout(3000);
    }
  }
  if (!resultSeen) fail("proof word never appeared in chat");
  await web.screenshot({ path: path.join(artifactDir, "live-07-result-in-chat.png") });
  await appWindow.screenshot({ path: path.join(artifactDir, "live-08-app-done.png") });

  // ---- 8. AUTO MODE: a proactive routine posts on its own ----------------
  step("auto mode run-now");
  const AUTO_WORD = `AUTOPROOF-${Date.now().toString(36).toUpperCase()}`;
  const autoCli = (args) => {
    const run = spawnSync(
      process.execPath,
      [
        path.join(appRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(appRoot, "scripts", "auto-config.ts"),
        ...args,
      ],
      {
        cwd: appRoot,
        env: { ...process.env, NODE_OPTIONS: "", GEMACLAW_HOME: ghome },
        encoding: "utf8",
        timeout: 240000,
      },
    );
    const jsonLine = (run.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .reverse()
      .find((line) => line.startsWith("{") && line.endsWith("}"));
    if (!jsonLine) fail(`auto-config ${args[0]} gave no result: ${run.stderr}`);
    return JSON.parse(jsonLine);
  };
  const setResult = autoCli([
    "--set-auto",
    JSON.stringify({
      enabled: true,
      routines: [
        {
          id: "e2e-proof",
          name: "E2E proof",
          prompt: `Write a one-line friendly note to the household that contains exactly the word ${AUTO_WORD}.`,
          // No scheduled days: run-now only — the app's live scheduler
          // must never see this routine as due during the test.
          schedule: { days: [], time: "12:00" },
          enabled: true,
        },
      ],
    }),
  ]);
  if (!setResult.ok) fail(`auto --set-auto failed: ${setResult.error}`);
  const runResult = autoCli(["--run-now", "e2e-proof"]);
  if (!runResult.ok || !runResult.posted)
    fail(`auto run-now failed: ${JSON.stringify(runResult).slice(0, 200)}`);
  if (!runResult.message.includes(AUTO_WORD))
    fail(`auto note missing proof word: "${runResult.message}"`);

  let autoSeen = false;
  for (let attempt = 0; attempt < 5 && !autoSeen; attempt++) {
    autoSeen = await web
      .waitForFunction(
        (word) => document.body.innerText.includes(word),
        AUTO_WORD,
        { timeout: 15000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!autoSeen) {
      await web.reload();
      await web.waitForTimeout(3000);
    }
  }
  if (!autoSeen) fail("auto-mode note never appeared in chat");
  await web.screenshot({ path: path.join(artifactDir, "live-09-auto-note-in-chat.png") });

  console.log(
    `LIVE E2E PASS — deep proof ${PROOF_WORD}, auto proof ${AUTO_WORD}, shots in ${artifactDir}`,
  );
} catch (err) {
  try {
    await web.screenshot({ path: path.join(artifactDir, "live-FAIL-web.png") });
    const appWindow = await app.firstWindow();
    await appWindow.screenshot({ path: path.join(artifactDir, "live-FAIL-app.png") });
  } catch {}
  throw err;
} finally {
  await app.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}
