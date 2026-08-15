import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import {
  alignBilingualCues,
  buildTimedTextUrl,
  formattedText,
  parseJson3Captions,
  selectCaptionTrack,
} from "../src/captions.mjs";

const DEFAULT_VIDEO = "https://www.youtube.com/watch?v=aircAruvnKk";

function readOption(name, fallback) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function normalizeVideoUrl(input) {
  if (/^[\w-]{11}$/.test(input)) {
    return `https://www.youtube.com/watch?v=${input}`;
  }

  const url = new URL(input);
  if (!/(^|\.)youtube\.com$/.test(url.hostname) && url.hostname !== "youtu.be") {
    throw new Error(`Only YouTube URLs are supported: ${input}`);
  }

  if (url.hostname === "youtu.be") {
    url.hostname = "www.youtube.com";
    url.pathname = "/watch";
    url.searchParams.set("v", input.split("/").filter(Boolean).at(-1));
  }

  url.searchParams.set("hl", "en");
  return url.toString();
}

async function fetchCaptionInPage(page, baseUrl, targetLanguage) {
  const requestedUrl = buildTimedTextUrl(baseUrl, { targetLanguage });
  return page.evaluate(
    async (captionUrl) => {
      const response = await fetch(captionUrl, { credentials: "include" });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // Keep the raw response details for diagnostics.
      }

      return {
        requestedUrl: captionUrl,
        status: response.status,
        contentType: response.headers.get("content-type"),
        length: text.length,
        json,
        rawPrefix: json ? null : text.slice(0, 300),
      };
    },
    requestedUrl,
  );
}

const videoInput = readOption("--video", process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : DEFAULT_VIDEO);
const sourceLanguage = readOption("--source", "en");
const targetLanguage = readOption("--target", "zh-Hans");
const headless = readOption("--headless", "true") !== "false";
const profileDirectory = readOption("--profile", null);
const browserChannel = readOption("--channel", "chrome");
const videoUrl = normalizeVideoUrl(videoInput);

const commonContextOptions = {
  locale: "en-US",
  extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
};

let browser = null;
const context = profileDirectory
  ? await chromium.launchPersistentContext(path.resolve(profileDirectory), {
      ...commonContextOptions,
      channel: browserChannel,
      headless,
      args: ["--profile-directory=Default"],
    })
  : await (async () => {
      browser = await chromium.launch({ headless });
      return browser.newContext(commonContextOptions);
    })();
const page = await context.newPage();
const timedTextResponses = [];

page.on("response", (response) => {
  if (response.url().includes("/api/timedtext")) {
    timedTextResponses.push({ status: response.status(), url: response.url() });
  }
});

try {
  await page.goto(videoUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(
    () => Boolean(globalThis.ytInitialPlayerResponse || globalThis.ytplayer?.config?.args?.player_response),
    null,
    { timeout: 30_000 },
  );

  const player = await page.evaluate(() => {
    if (globalThis.ytInitialPlayerResponse) return globalThis.ytInitialPlayerResponse;
    const serialized = globalThis.ytplayer?.config?.args?.player_response;
    return serialized ? JSON.parse(serialized) : null;
  });

  const renderer = player?.captions?.playerCaptionsTracklistRenderer;
  const tracks = renderer?.captionTracks ?? [];
  const translationLanguages = renderer?.translationLanguages ?? [];

  if (!tracks.length) {
    throw new Error(
      `No caption tracks found. Player status: ${player?.playabilityStatus?.status ?? "unknown"}; reason: ${player?.playabilityStatus?.reason ?? "none"}`,
    );
  }

  const selectedTrack = selectCaptionTrack(tracks, sourceLanguage);

  const original = await fetchCaptionInPage(page, selectedTrack.baseUrl, null);
  const translated = await fetchCaptionInPage(page, selectedTrack.baseUrl, targetLanguage);
  const originalCues = parseJson3Captions(original.json);
  const translatedCues = parseJson3Captions(translated.json);
  const bilingualCues = alignBilingualCues(originalCues, translatedCues);

  const report = {
    testedAt: new Date().toISOString(),
    pageUrl: page.url(),
    video: {
      id: player.videoDetails?.videoId ?? null,
      title: player.videoDetails?.title ?? null,
      author: player.videoDetails?.author ?? null,
    },
    playerStatus: player.playabilityStatus?.status ?? null,
    captionTracks: tracks.map((track) => ({
      languageCode: track.languageCode,
      name: formattedText(track.name),
      kind: track.kind ?? "manual",
      isTranslatable: track.isTranslatable ?? false,
      vssId: track.vssId ?? null,
    })),
    translationLanguages: translationLanguages.map((language) => ({
      languageCode: language.languageCode,
      name: formattedText(language.languageName),
    })),
    selected: {
      sourceLanguage: selectedTrack.languageCode,
      sourceKind: selectedTrack.kind ?? "manual",
      targetLanguage,
    },
    original: {
      status: original.status,
      contentType: original.contentType,
      length: original.length,
      cueCount: originalCues.length,
      preview: originalCues.slice(0, 5),
      rawPrefix: original.rawPrefix,
    },
    translated: {
      status: translated.status,
      contentType: translated.contentType,
      length: translated.length,
      cueCount: translatedCues.length,
      preview: translatedCues.slice(0, 5),
      rawPrefix: translated.rawPrefix,
    },
    timedTextResponses,
  };

  await mkdir("artifacts", { recursive: true });
  const outputPath = path.join("artifacts", `${report.video.id}-${sourceLanguage}-${targetLanguage}-report.json`);
  const bilingualPath = path.join("artifacts", `${report.video.id}-${sourceLanguage}-${targetLanguage}-bilingual.json`);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(bilingualPath, `${JSON.stringify(bilingualCues, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        ...report,
        artifacts: {
          report: path.resolve(outputPath),
          bilingual: path.resolve(bilingualPath),
        },
      },
      null,
      2,
    ),
  );

  if (original.status !== 200 || original.length === 0) {
    throw new Error("Original caption request did not return a non-empty 200 response.");
  }
  if (translated.status !== 200 || translated.length === 0) {
    throw new Error("Translated caption request did not return a non-empty 200 response.");
  }
} finally {
  if (browser) await browser.close();
  else await context.close();
}
