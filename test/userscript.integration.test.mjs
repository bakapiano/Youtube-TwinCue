import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";

const userscript = await readFile(path.resolve("userscript", "TwinCue.user.js"), "utf8");
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
<html><head><meta charset="utf-8"><title>TwinCue test</title></head>
<body>
  <div id="movie_player" style="position:relative;width:960px;height:540px;background:#111"></div>
  <script>
    window.ytInitialPlayerResponse = {
      playabilityStatus: { status: "OK" },
      videoDetails: { videoId: "testvideo01", title: "Userscript fixture", author: "Local test" },
      captions: { playerCaptionsTracklistRenderer: {
        defaultAudioTrackIndex: 0,
        audioTracks: [{ audioTrackId: "en.4", defaultCaptionTrackIndex: 0, captionTrackIndices: [0, 1] }],
        captionTracks: [
          { languageCode: "fr", name: { simpleText: "French" }, vssId: ".fr", isTranslatable: true },
          { languageCode: "en", name: { simpleText: "English" }, vssId: ".en", isTranslatable: true }
        ]
      } }
    };
    const player = document.querySelector("#movie_player");
    player.loadModule = () => {};
    player.getCurrentTime = () => 1;
    player.setOption = (_module, option, track) => {
      if (option !== "track" || !track?.languageCode) return;
      const url = new URL("/api/timedtext", location.origin);
      url.searchParams.set("v", "testvideo01");
      url.searchParams.set("lang", track.languageCode);
      url.searchParams.set("fmt", "json3");
      url.searchParams.set("pot", "fixture-pot");
      if (track.translationLanguage?.languageCode) url.searchParams.set("tlang", track.translationLanguage.languageCode);
      fetch(url);
    };
    document.dispatchEvent(new Event("yt-navigate-finish"));
  </script>
</body></html>`;

test("TwinCue userscript detects the source language and renders bilingual captions", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript({ content: userscript });
    await page.route(/^https:\/\/www\.youtube\.com\/watch(?:\?|$)/, (route) => route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: mockPage,
    }));
    await page.route(/^https:\/\/www\.youtube\.com\/api\/timedtext(?:\?|$)/, (route) => {
      const url = new URL(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(url.searchParams.has("tlang") ? translatedPayload : sourcePayload),
      });
    });

    await page.goto("https://www.youtube.com/watch?v=testvideo01", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForFunction(() => window.TwinCue?.getStatus().state === "ready", null, {
      timeout: 30_000,
    });

    const result = await page.evaluate(() => {
      const root = document.querySelector("#twincue-root")?.shadowRoot;
      window.TwinCue.openSettings();
      window.TwinCue.setSettings({ uiLanguage: "en" });
      return {
        version: window.TwinCue.version,
        status: window.TwinCue.getStatus(),
        source: root?.querySelector("#source")?.textContent,
        translated: root?.querySelector("#translated")?.textContent,
        nativeCaptionHidden: document.body.classList.contains("twincue-ready"),
        panelTitle: root?.querySelector(".panel-title span")?.textContent,
        targetOptionCount: root?.querySelectorAll('[data-setting="targetLanguage"] option').length,
        settings: window.TwinCue.getSettings(),
      };
    });

    assert.equal(result.version, "0.3.0");
    assert.equal(result.status.sourceLanguage, "en");
    assert.equal(result.status.autoDetectedSource, true);
    assert.equal(result.source, "Hello from YouTube");
    assert.equal(result.translated, "来自 YouTube 的问候");
    assert.equal(result.nativeCaptionHidden, true);
    assert.equal(result.panelTitle, "TwinCue Settings");
    assert.equal(result.targetOptionCount, 20);
    assert.equal(result.settings.sourceLanguage, "auto");
    assert.equal(result.settings.uiLanguage, "en");
  } finally {
    await browser.close();
  }
});
