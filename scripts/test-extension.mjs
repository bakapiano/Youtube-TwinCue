import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const chromePath = path.join(
  process.env.LOCALAPPDATA,
  "ms-playwright",
  "chromium-1223",
  "chrome-win64",
  "chrome.exe",
);
const extensionPath = path.resolve("extension");
const artifactsPath = path.resolve("artifacts");
const profilePath = path.join(artifactsPath, "extension-test-profile");

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

async function waitForCdp(port, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Chrome exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Browser startup is still in progress.
    }
    await delay(250);
  }
  throw new Error("Chrome for Testing did not expose CDP.");
}

const sourcePayload = {
  events: [
    { tStartMs: 0, dDurationMs: 60_000, segs: [{ utf8: "Hello from YouTube" }] },
  ],
};
const translatedPayload = {
  events: [
    { tStartMs: 0, dDurationMs: 60_000, segs: [{ utf8: "来自 YouTube 的问候" }] },
  ],
};
const mockPage = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>Extension test</title></head>
<body>
  <div id="movie_player" style="position:relative;width:960px;height:540px;background:#111"></div>
  <script>
    window.ytInitialPlayerResponse = {
      playabilityStatus: { status: "OK" },
      videoDetails: { videoId: "testvideo01", title: "Extension fixture", author: "Local test" },
      captions: { playerCaptionsTracklistRenderer: {
        defaultAudioTrackIndex: 0,
        audioTracks: [{
          audioTrackId: "en.4",
          defaultCaptionTrackIndex: 0,
          captionTrackIndices: [0, 1]
        }],
        captionTracks: [
          {
            languageCode: "fr",
            name: { simpleText: "French" },
            vssId: ".fr",
            isTranslatable: true,
            baseUrl: "https://www.youtube.com/api/timedtext?v=testvideo01&lang=fr"
          },
          {
            languageCode: "en",
            name: { simpleText: "English" },
            vssId: ".en",
            isTranslatable: true,
            baseUrl: "https://www.youtube.com/api/timedtext?v=testvideo01&lang=en"
          }
        ]
      } }
    };
    const player = document.querySelector("#movie_player");
    player.loadModule = () => {};
    player.getCurrentTime = () => 1;
    player.setOption = (_module, option, track) => {
      if (option !== "track" || !track || !track.languageCode) return;
      const url = new URL("/api/timedtext", location.origin);
      url.searchParams.set("v", "testvideo01");
      url.searchParams.set("lang", track.languageCode);
      url.searchParams.set("fmt", "json3");
      url.searchParams.set("pot", "fixture-pot");
      if (track.translationLanguage?.languageCode) {
        url.searchParams.set("tlang", track.translationLanguage.languageCode);
      }
      fetch(url);
    };
    document.dispatchEvent(new Event("yt-navigate-finish"));
  </script>
</body></html>`;

if (!profilePath.startsWith(`${artifactsPath}${path.sep}`)) {
  throw new Error("Extension test profile escaped the artifacts directory.");
}
await rm(profilePath, { recursive: true, force: true });
await mkdir(profilePath, { recursive: true });
const port = await freePort();
const chrome = spawn(
  chromePath,
  [
    `--user-data-dir=${profilePath}`,
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--window-position=-32000,-32000",
    "--window-size=1200,900",
    "about:blank",
  ],
  { stdio: "ignore", windowsHide: false },
);

let browser = null;
try {
  await waitForCdp(port, chrome);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  await page.route(/^https:\/\/www\.youtube\.com\/watch(?:\?|$)/, (route) => route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: mockPage,
  }));
  await page.route(/^https:\/\/www\.youtube\.com\/api\/timedtext(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const payload = url.searchParams.has("tlang") ? translatedPayload : sourcePayload;
    return route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(payload),
    });
  });

  await page.goto("https://www.youtube.com/watch?v=testvideo01", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  try {
    await page.waitForFunction(() => {
      try {
        return JSON.parse(document.documentElement.getAttribute("data-yt-native-bilingual-status") || "null")?.state === "ready";
      } catch {
        return false;
      }
    }, null, { timeout: 30_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      installed: Boolean(window.__ytNativeBilingualInstalled),
      config: document.documentElement.getAttribute("data-yt-native-bilingual-config"),
      status: document.documentElement.getAttribute("data-yt-native-bilingual-status"),
      overlay: Boolean(document.querySelector("#yt-native-bilingual-overlay")),
      source: document.querySelector(".yt-native-bilingual-source")?.textContent,
      translated: document.querySelector(".yt-native-bilingual-translated")?.textContent,
      initialPlayerVideoId: window.ytInitialPlayerResponse?.videoDetails?.videoId,
      initialPlayerKeys: Object.keys(window.ytInitialPlayerResponse || {}),
      playerHasSetOption: typeof document.querySelector("#movie_player")?.setOption,
    }));
    throw new Error(`Extension did not become ready: ${JSON.stringify(diagnostic)}`, { cause: error });
  }

  const result = await page.evaluate(() => ({
    installed: Boolean(window.__ytNativeBilingualInstalled),
    source: document.querySelector(".yt-native-bilingual-source")?.textContent,
    translated: document.querySelector(".yt-native-bilingual-translated")?.textContent,
    status: JSON.parse(document.documentElement.getAttribute("data-yt-native-bilingual-status") || "null"),
    nativeCaptionHidden: document.body.classList.contains("yt-native-bilingual-ready"),
  }));

  if (!result.installed) throw new Error("Extension main-world script was not installed.");
  if (result.source !== "Hello from YouTube") throw new Error("Source overlay text is incorrect.");
  if (result.translated !== "来自 YouTube 的问候") throw new Error("Translated overlay text is incorrect.");
  if (!result.nativeCaptionHidden) throw new Error("Native caption suppression was not activated.");
  if (result.status.sourceLanguage !== "en" || !result.status.autoDetectedSource) {
    throw new Error("Source-language auto-detection did not select the default English track.");
  }

  const report = { verified: true, ...result };
  await writeFile(
    path.resolve("artifacts", "extension-test-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (chrome.exitCode === null) chrome.kill();
}
