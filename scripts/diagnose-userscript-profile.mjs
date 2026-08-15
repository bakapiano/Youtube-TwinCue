import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright";

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profilePath = path.resolve(".browser-profile", "chrome");
const userscript = await readFile(path.resolve("userscript", "TwinCue.user.js"), "utf8");
const settings = {
  enabled: true,
  sourceLanguage: "auto",
  sourceKind: "any",
  targetLanguage: "zh-Hans",
  uiLanguage: "zh-CN",
};

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not allocate a CDP port.");
  return port;
}

const port = await freePort();
const chrome = spawn(
  chromePath,
  [
    `--user-data-dir=${profilePath}`,
    "--profile-directory=Default",
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    "--window-position=-32000,-32000",
    "--window-size=1200,900",
    "about:blank",
  ],
  { stdio: "ignore", windowsHide: false },
);

let browser = null;
try {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) break;
    } catch {
      // Browser startup is still in progress.
    }
    await delay(250);
  }

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  const pageErrors = [];
  const timedText = [];
  page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 1000)));
  page.on("response", async (response) => {
    if (!response.url().includes("/api/timedtext")) return;
    const url = new URL(response.url());
    let bytes = 0;
    try {
      bytes = (await response.body()).length;
    } catch {
      // A cancelled caption switch may have no body.
    }
    timedText.push({
      status: response.status(),
      bytes,
      lang: url.searchParams.get("lang"),
      kind: url.searchParams.get("kind"),
      tlang: url.searchParams.get("tlang"),
      hasPoToken: url.searchParams.has("pot"),
    });
  });

  await page.addInitScript({
    content: `localStorage.setItem("twincue:settings:v1", ${JSON.stringify(JSON.stringify(settings))});\n${userscript}`,
  });
  await page.goto("https://www.youtube.com/watch?v=aircAruvnKk&hl=en", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => Boolean(document.querySelector("#movie_player") && window.TwinCue),
    null,
    { timeout: 30_000 },
  );
  await page.evaluate(() => {
    const player = document.querySelector("#movie_player");
    player?.mute?.();
    player?.playVideo?.();
  });
  try {
    await page.waitForFunction(() => ["ready", "error"].includes(window.TwinCue?.getStatus().state), null, {
      timeout: 45_000,
    });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      installed: Boolean(window.__TwinCueUserscriptInstalled),
      hasApi: Boolean(window.TwinCue),
      status: window.TwinCue?.getStatus(),
      settings: window.TwinCue?.getSettings(),
      playerStatus: window.ytInitialPlayerResponse?.playabilityStatus?.status,
      videoId: window.ytInitialPlayerResponse?.videoDetails?.videoId,
      playerPresent: Boolean(document.querySelector("#movie_player")),
      rootPresent: Boolean(document.querySelector("#twincue-root")),
    }));
    throw new Error(`Userscript did not settle: ${JSON.stringify(diagnostic)}`, { cause: error });
  }

  const pageState = await page.evaluate(() => {
    const root = document.querySelector("#twincue-root")?.shadowRoot;
    return {
      installed: Boolean(window.__TwinCueUserscriptInstalled),
      version: window.TwinCue?.version,
      loggedIn: window.ytcfg?.get?.("LOGGED_IN") ?? null,
      playerStatus: window.ytInitialPlayerResponse?.playabilityStatus?.status ?? null,
      status: window.TwinCue?.getStatus(),
      overlayPresent: Boolean(root?.querySelector("#overlay")),
      sourceTextLength: root?.querySelector("#source")?.textContent.length || 0,
      translatedTextLength: root?.querySelector("#translated")?.textContent.length || 0,
      settingsButtonPresent: Boolean(root?.querySelector("#settings-button")),
      nativeCaptionHidden: document.body.classList.contains("twincue-ready"),
    };
  });

  const report = {
    testedAt: new Date().toISOString(),
    pageState,
    timedText,
    pageErrors,
  };
  await writeFile(
    path.resolve("artifacts", "userscript-profile-diagnostic.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify(report, null, 2));

  if (pageState.status?.state !== "ready") process.exitCode = 1;
  if (!pageState.loggedIn || pageState.playerStatus !== "OK") process.exitCode = 1;
  if (!pageState.sourceTextLength || !pageState.translatedTextLength) process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (chrome.exitCode === null) chrome.kill();
}
