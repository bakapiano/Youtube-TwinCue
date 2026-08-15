import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const userscript = await readFile(path.resolve("userscript", "TwinCue.user.js"), "utf8");
const outputDirectory = path.resolve("docs", "images");
const sourcePayload = {
  events: [
    { tStartMs: 0, dDurationMs: 60_000, segs: [{ utf8: "Natural subtitles from YouTube" }] },
  ],
};
const translatedPayload = {
  events: [
    { tStartMs: 0, dDurationMs: 60_000, segs: [{ utf8: "来自 YouTube 的原生字幕" }] },
  ],
};
const mockPage = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>TwinCue demo</title>
<style>
  * { box-sizing: border-box; }
  html, body { width:100%;height:100%;margin:0;background:#0f0f0f;overflow:hidden;font-family:Arial,sans-serif; }
  body { display:grid;place-items:center; }
  #movie_player { position:relative;width:1180px;height:664px;overflow:hidden;background:radial-gradient(circle at 72% 25%,#6544a4 0,#302657 25%,#16213b 55%,#090d18 100%);box-shadow:0 20px 55px rgba(0,0,0,.55); }
  .glow { position:absolute;border-radius:50%;filter:blur(4px);opacity:.7; }
  .glow.one { width:260px;height:260px;left:170px;top:115px;background:linear-gradient(135deg,#00c6ff,#0072ff); }
  .glow.two { width:330px;height:210px;right:140px;bottom:120px;background:linear-gradient(135deg,#f953c6,#b91d73);transform:rotate(-18deg); }
  .brand { position:absolute;inset:0;display:grid;place-items:center;color:rgba(255,255,255,.92);font-size:58px;font-weight:800;letter-spacing:5px;text-shadow:0 5px 24px rgba(0,0,0,.45); }
  .brand small { display:block;margin-top:10px;font-size:17px;font-weight:500;letter-spacing:2px;text-align:center;color:#d8dcff; }
  .controls { position:absolute;left:0;right:0;bottom:0;height:58px;background:linear-gradient(transparent,rgba(0,0,0,.88)); }
  .progress { position:absolute;left:18px;right:18px;bottom:43px;height:3px;background:rgba(255,255,255,.35); }
  .progress::before { content:"";display:block;width:38%;height:100%;background:#f00; }
  .play { position:absolute;left:24px;bottom:15px;width:0;height:0;border-top:9px solid transparent;border-bottom:9px solid transparent;border-left:15px solid #fff; }
  .control-dot { position:absolute;bottom:16px;width:18px;height:18px;border:2px solid #fff;border-radius:50%;opacity:.9; }
  .control-dot.one { left:72px; }.control-dot.two { right:66px; }.control-dot.three { right:28px; }
</style></head>
<body>
  <div id="movie_player">
    <div class="glow one"></div><div class="glow two"></div>
    <div class="brand"><div>TWINCUE<small>NATIVE BILINGUAL SUBTITLES</small></div></div>
    <div class="controls"><div class="progress"></div><div class="play"></div><div class="control-dot one"></div><div class="control-dot two"></div><div class="control-dot three"></div></div>
  </div>
  <script>
    window.ytInitialPlayerResponse = {
      playabilityStatus: { status: "OK" },
      videoDetails: { videoId: "testvideo01", title: "TwinCue demo", author: "TwinCue" },
      captions: { playerCaptionsTracklistRenderer: {
        defaultAudioTrackIndex: 0,
        audioTracks: [{ audioTrackId: "en.4", defaultCaptionTrackIndex: 0, captionTrackIndices: [0] }],
        captionTracks: [{ languageCode: "en", name: { simpleText: "English" }, vssId: ".en", isTranslatable: true }]
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

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
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
  await page.goto("https://www.youtube.com/watch?v=testvideo01", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.TwinCue?.getStatus().state === "ready");

  const player = page.locator("#movie_player");
  for (const [uiLanguage, filename] of [
    ["en", "twincue-usage-en.png"],
    ["zh-CN", "twincue-usage-zh-CN.png"],
  ]) {
    const previousStatusTime = await page.evaluate(() => window.TwinCue.getStatus().at);
    await page.evaluate((language) => {
      window.TwinCue.setSettings({ uiLanguage: language, targetLanguage: "zh-Hans" });
    }, uiLanguage);
    await page.waitForFunction((previous) => {
      const status = window.TwinCue?.getStatus();
      return status?.state === "ready" && status.at !== previous;
    }, previousStatusTime);
    await page.evaluate(() => window.TwinCue.openSettings());
    await page.waitForTimeout(150);
    await player.screenshot({ path: path.join(outputDirectory, filename) });
  }
} finally {
  await browser.close();
}

console.log(`Wrote screenshots to ${outputDirectory}`);
