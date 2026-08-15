import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright";

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profilePath = path.resolve(".browser-profile", "chrome");
const mainScript = await readFile(path.resolve("extension", "main.js"), "utf8");

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
  const consoleErrors = [];
  const pageErrors = [];
  const timedText = [];

  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      consoleErrors.push({ type: message.type(), text: message.text().slice(0, 500) });
    }
  });
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

  await page.addInitScript({ content: mainScript });
  await page.addInitScript({
    content: `(() => {
      const config = ${JSON.stringify({
        enabled: true,
        sourceLanguage: "auto",
        sourceKind: "any",
        targetLanguage: "zh-Hans",
        uiLanguage: "zh-CN",
        settingsVersion: 2,
      })};
      const publish = () => {
        const root = document.documentElement;
        if (!root) return setTimeout(publish, 0);
        root.setAttribute("data-yt-native-bilingual-config", JSON.stringify(config));
        root.dispatchEvent(new Event("yt-native-bilingual-config"));
      };
      publish();
    })();`,
  });

  await page.goto("https://www.youtube.com/watch?v=aircAruvnKk&hl=en", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => Boolean(document.querySelector("#movie_player") && window.ytInitialPlayerResponse),
    null,
    { timeout: 30_000 },
  );
  await page.evaluate(() => {
    const player = document.querySelector("#movie_player");
    player?.mute?.();
    player?.playVideo?.();
  });

  await page.waitForFunction(() => {
    try {
      const status = JSON.parse(document.documentElement.getAttribute("data-yt-native-bilingual-status") || "null");
      return status && ["ready", "error"].includes(status.state);
    } catch {
      return false;
    }
  }, null, { timeout: 45_000 });

  const pageState = await page.evaluate(() => {
    const status = JSON.parse(document.documentElement.getAttribute("data-yt-native-bilingual-status") || "null");
    const source = document.querySelector(".yt-native-bilingual-source")?.textContent || "";
    const translated = document.querySelector(".yt-native-bilingual-translated")?.textContent || "";
    const renderer = window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer;
    return {
      installed: Boolean(window.__ytNativeBilingualInstalled),
      loggedIn: window.ytcfg?.get?.("LOGGED_IN") ?? null,
      playerStatus: window.ytInitialPlayerResponse?.playabilityStatus?.status ?? null,
      status,
      overlayPresent: Boolean(document.querySelector("#yt-native-bilingual-overlay")),
      sourceTextLength: source.length,
      translatedTextLength: translated.length,
      nativeCaptionHidden: document.body.classList.contains("yt-native-bilingual-ready"),
      captionMetadata: {
        rendererKeys: Object.keys(renderer || {}),
        defaultAudioTrackIndex: renderer?.defaultAudioTrackIndex ?? null,
        audioTracks: (renderer?.audioTracks || []).map((track) => ({
          keys: Object.keys(track),
          id: track.id ?? null,
          audioTrackId: track.audioTrackId ?? null,
          audioTrackType: track.audioTrackType ?? null,
          defaultCaptionTrackIndex: track.defaultCaptionTrackIndex ?? null,
          captionTrackIndices: track.captionTrackIndices ?? null,
        })),
        captionTracks: (renderer?.captionTracks || []).map((track, index) => ({
          index,
          keys: Object.keys(track),
          languageCode: track.languageCode,
          kind: track.kind || "manual",
          name: track.name?.simpleText || track.name?.runs?.map((run) => run.text).join("") || "",
          vssId: track.vssId ?? null,
          isDefault: track.isDefault ?? null,
          audioTrackType: track.audioTrackType ?? null,
        })),
      },
    };
  });

  const report = {
    testedAt: new Date().toISOString(),
    pageState,
    timedText,
    pageErrors,
    consoleErrors: consoleErrors.slice(-20),
  };
  await writeFile(
    path.resolve("artifacts", "profile-extension-diagnostic.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (chrome.exitCode === null) chrome.kill();
}
