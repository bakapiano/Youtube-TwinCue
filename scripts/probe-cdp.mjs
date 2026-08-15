import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import {
  alignBilingualCues,
  formattedText,
  parseJson3Captions,
} from "../src/captions.mjs";

const DEFAULT_VIDEO = "aircAruvnKk";
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

function readOption(name, fallback) {
  const prefix = `${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function videoIdFrom(input) {
  if (/^[\w-]{11}$/.test(input)) return input;
  const url = new URL(input);
  if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0];
  const id = url.searchParams.get("v");
  if (!id) throw new Error(`Cannot find a YouTube video id in: ${input}`);
  return id;
}

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

async function waitForCdp(port, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Chrome exited early with code ${child.exitCode}.`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome has not opened its debugging endpoint yet.
    }
    await delay(250);
  }
  throw new Error(`Chrome did not expose CDP on port ${port}.`);
}

function trackMatches(track, language, kind) {
  if (track.languageCode !== language) return false;
  if (kind === "asr") return track.kind === "asr";
  if (kind === "manual") return track.kind !== "asr";
  return true;
}

function requestMatches(capture, { language, kind, targetLanguage }) {
  if (capture.status !== 200 || capture.text.length === 0) return false;
  if (capture.params.lang !== language) return false;
  if (kind === "asr" && capture.params.kind !== "asr") return false;
  if (kind === "manual" && capture.params.kind === "asr") return false;
  return targetLanguage
    ? capture.params.tlang === targetLanguage
    : !capture.params.tlang;
}

async function waitForCapture(captures, matcher, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = captures.find(matcher);
    if (match) return match;
    await delay(200);
  }
  return captures.find(matcher) ?? null;
}

async function deriveCaption(page, templateUrl, { language, targetLanguage }) {
  return page.evaluate(
    async ({ rawUrl, lang, tlang }) => {
      const url = new URL(rawUrl);
      url.searchParams.set("lang", lang);
      if (tlang) url.searchParams.set("tlang", tlang);
      else url.searchParams.delete("tlang");
      url.searchParams.set("_caption_lab", Date.now().toString());

      const response = await fetch(url, { credentials: "include" });
      const text = await response.text();
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        url: url.toString(),
        text,
      };
    },
    { rawUrl: templateUrl, lang: language, tlang: targetLanguage },
  );
}

function captureFromDerived(result) {
  const url = new URL(result.url);
  return {
    status: result.status,
    contentType: result.contentType,
    url: result.url,
    text: result.text,
    params: Object.fromEntries(url.searchParams),
    derived: true,
  };
}

function responseSummary(capture, cueCount) {
  return {
    status: capture.status,
    contentType: capture.contentType,
    bytes: Buffer.byteLength(capture.text),
    cueCount,
    hasPoToken: Boolean(capture.params.pot),
    derivedFromPlayerRequest: Boolean(capture.derived),
    sha256: createHash("sha256").update(capture.text).digest("hex"),
  };
}

const videoId = videoIdFrom(readOption("--video", DEFAULT_VIDEO));
const sourceLanguage = readOption("--source", "en");
const sourceKind = readOption("--kind", "manual");
const targetLanguage = readOption("--target", "zh-Hans");
const profileDirectory = path.resolve(readOption("--profile", ".browser-profile/chrome"));
const timeoutMs = Number(readOption("--timeout", "20000"));

if (!["manual", "asr", "any"].includes(sourceKind)) {
  throw new Error("--kind must be manual, asr, or any.");
}

const port = await freePort();
const chrome = spawn(
  CHROME_PATH,
  [
    `--user-data-dir=${profileDirectory}`,
    "--profile-directory=Default",
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
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
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

  const captures = [];
  page.on("response", (response) => {
    if (!response.url().includes("/api/timedtext")) return;
    void (async () => {
      let text = "";
      try {
        text = await response.text();
      } catch {
        // A cancelled track switch may have no readable body.
      }
      const url = new URL(response.url());
      captures.push({
        status: response.status(),
        contentType: response.headers()["content-type"] ?? null,
        url: response.url(),
        text,
        params: Object.fromEntries(url.searchParams),
        derived: false,
      });
    })();
  });

  const watchUrl = new URL("https://www.youtube.com/watch");
  watchUrl.searchParams.set("v", videoId);
  watchUrl.searchParams.set("hl", "en");
  watchUrl.searchParams.set("cc_load_policy", "1");
  watchUrl.searchParams.set("cc_lang_pref", sourceLanguage);
  await page.goto(watchUrl.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(
    () => Boolean(globalThis.ytInitialPlayerResponse),
    null,
    { timeout: 30_000 },
  );

  const playerData = await page.evaluate(() => ({
    response: globalThis.ytInitialPlayerResponse,
    loggedIn: globalThis.ytcfg?.get?.("LOGGED_IN") ?? null,
    webdriver: navigator.webdriver,
  }));
  const playerResponse = playerData.response;
  if (playerResponse?.playabilityStatus?.status !== "OK") {
    throw new Error(
      `Player status ${playerResponse?.playabilityStatus?.status ?? "unknown"}: ${playerResponse?.playabilityStatus?.reason ?? "no reason"}`,
    );
  }

  const renderer = playerResponse?.captions?.playerCaptionsTracklistRenderer;
  const tracks = renderer?.captionTracks ?? [];
  const selectedTrack = tracks.find((track) => trackMatches(track, sourceLanguage, sourceKind));
  if (!selectedTrack) {
    const available = tracks.map((track) => `${track.languageCode}:${track.kind ?? "manual"}`).join(", ");
    throw new Error(`Requested caption track was not found. Available: ${available || "none"}`);
  }

  const trackOption = {
    languageCode: selectedTrack.languageCode,
    kind: selectedTrack.kind ?? "",
    vss_id: selectedTrack.vssId,
  };

  await page.evaluate(() => {
    const player = document.querySelector("#movie_player");
    player?.mute?.();
    player?.loadModule?.("captions");
    player?.playVideo?.();
  });
  await delay(2_000);
  await page.evaluate((track) => {
    const player = document.querySelector("#movie_player");
    player?.setOption?.("captions", "track", {});
    player?.setOption?.("captions", "track", track);
  }, trackOption);

  let sourceCapture = await waitForCapture(
    captures,
    (capture) => requestMatches(capture, {
      language: sourceLanguage,
      kind: sourceKind,
      targetLanguage: null,
    }),
    Math.min(timeoutMs, 8_000),
  );

  const translatedOption = {
    ...trackOption,
    translationLanguage: { languageCode: targetLanguage },
  };
  await page.evaluate((track) => {
    document.querySelector("#movie_player")?.setOption?.("captions", "track", track);
  }, translatedOption);
  let translatedCapture = await waitForCapture(
    captures,
    (capture) => requestMatches(capture, {
      language: sourceLanguage,
      kind: sourceKind,
      targetLanguage,
    }),
    timeoutMs,
  );

  if (!sourceCapture && translatedCapture) {
    sourceCapture = captureFromDerived(
      await deriveCaption(page, translatedCapture.url, {
        language: sourceLanguage,
        targetLanguage: null,
      }),
    );
  }
  if (!translatedCapture && sourceCapture) {
    translatedCapture = captureFromDerived(
      await deriveCaption(page, sourceCapture.url, {
        language: sourceLanguage,
        targetLanguage,
      }),
    );
  }

  if (!sourceCapture?.text) throw new Error("The source caption response was empty.");
  if (!translatedCapture?.text) throw new Error("The translated caption response was empty.");

  const sourcePayload = JSON.parse(sourceCapture.text);
  const translatedPayload = JSON.parse(translatedCapture.text);
  const sourceCues = parseJson3Captions(sourcePayload);
  const translatedCues = parseJson3Captions(translatedPayload);
  const bilingualCues = alignBilingualCues(sourceCues, translatedCues);
  if (!sourceCues.length || !translatedCues.length) {
    throw new Error("YouTube returned JSON, but no usable caption cues were found.");
  }

  const stem = `${videoId}-${sourceLanguage}-${sourceKind}-${targetLanguage}`;
  await mkdir("artifacts", { recursive: true });
  const paths = {
    report: path.resolve("artifacts", `${stem}-report.json`),
    source: path.resolve("artifacts", `${stem}-source.json`),
    translated: path.resolve("artifacts", `${stem}-translated.json`),
    bilingual: path.resolve("artifacts", `${stem}-bilingual.json`),
  };

  const report = {
    testedAt: new Date().toISOString(),
    method: "normal Chrome + Playwright connectOverCDP",
    browser: {
      navigatorWebdriver: playerData.webdriver,
      loggedIn: playerData.loggedIn,
    },
    video: {
      id: playerResponse.videoDetails?.videoId ?? videoId,
      title: playerResponse.videoDetails?.title ?? null,
      author: playerResponse.videoDetails?.author ?? null,
    },
    playerStatus: playerResponse.playabilityStatus?.status,
    selectedTrack: {
      languageCode: selectedTrack.languageCode,
      kind: selectedTrack.kind ?? "manual",
      name: formattedText(selectedTrack.name),
      isTranslatable: selectedTrack.isTranslatable ?? false,
      vssId: selectedTrack.vssId ?? null,
    },
    targetLanguage,
    source: responseSummary(sourceCapture, sourceCues.length),
    translated: responseSummary(translatedCapture, translatedCues.length),
    bilingualCueCount: bilingualCues.length,
    artifacts: paths,
  };

  await Promise.all([
    writeFile(paths.report, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(paths.source, `${JSON.stringify(sourcePayload, null, 2)}\n`, "utf8"),
    writeFile(paths.translated, `${JSON.stringify(translatedPayload, null, 2)}\n`, "utf8"),
    writeFile(paths.bilingual, `${JSON.stringify(bilingualCues, null, 2)}\n`, "utf8"),
  ]);

  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (chrome.exitCode === null) chrome.kill();
}
