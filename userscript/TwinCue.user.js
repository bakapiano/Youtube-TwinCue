// ==UserScript==
// @name         TwinCue – Native Bilingual Subtitles for YouTube
// @name:zh-CN   TwinCue – YouTube 原生双语字幕
// @namespace    https://github.com/bakapiano/Youtube-TwinCue
// @version      0.3.1
// @description  Auto-detect YouTube captions and display synchronized source and auto-translated subtitles.
// @description:zh-CN 自动识别 YouTube 原字幕，并同步显示原文与 YouTube 自动翻译字幕。
// @author       Bakapiano
// @homepageURL  https://github.com/bakapiano/Youtube-TwinCue
// @supportURL   https://github.com/bakapiano/Youtube-TwinCue/issues
// @downloadURL  https://raw.githubusercontent.com/bakapiano/Youtube-TwinCue/main/userscript/TwinCue.user.js
// @updateURL    https://raw.githubusercontent.com/bakapiano/Youtube-TwinCue/main/userscript/TwinCue.user.js
// @match        https://www.youtube.com/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  "use strict";

  if (window.top !== window.self || window.__TwinCueUserscriptInstalled) return;
  window.__TwinCueUserscriptInstalled = true;

  const VERSION = "0.3.1";
  const SETTINGS_KEY = "twincue:settings:v1";
  const DEFAULT_SETTINGS = {
    enabled: true,
    sourceLanguage: "auto",
    sourceKind: "any",
    targetLanguage: "zh-Hans",
    uiLanguage: "zh-CN",
  };
  const MESSAGES = {
    "zh-CN": {
      settings: "TwinCue 设置",
      close: "关闭",
      enabled: "启用双语字幕",
      uiLanguage: "界面语言",
      sourceLanguage: "原字幕语言",
      autoDetect: "自动识别",
      sourceKind: "原字幕类型",
      targetLanguage: "翻译语言",
      kindAny: "优先人工，自动回退",
      kindManual: "仅人工字幕",
      kindAsr: "仅自动生成字幕",
      loading: "双语字幕加载中…",
      ready: "双语字幕已就绪",
      disabled: "双语字幕已关闭",
      waiting: "等待 YouTube 页面…",
      detected: "已识别：{name}（{code}）",
      noPlayerTracks: "未取得播放器字幕轨道",
      videoUnavailable: "视频不可播放",
      noTrack: "没有可用的原字幕轨道",
      requestedKindMissing: "自动识别到 {language}，但没有所选类型的字幕",
      notTranslatable: "该字幕轨道不支持自动翻译",
      noPoToken: "播放器未返回有效字幕请求；请播放视频后重试",
      emptyResponse: "字幕响应为空",
    },
    en: {
      settings: "TwinCue Settings",
      close: "Close",
      enabled: "Enable bilingual subtitles",
      uiLanguage: "Interface language",
      sourceLanguage: "Source subtitle language",
      autoDetect: "Auto-detect",
      sourceKind: "Source caption type",
      targetLanguage: "Translation language",
      kindAny: "Prefer manual, fall back to auto",
      kindManual: "Manual captions only",
      kindAsr: "Auto-generated captions only",
      loading: "Loading bilingual subtitles…",
      ready: "Bilingual subtitles ready",
      disabled: "Bilingual subtitles disabled",
      waiting: "Waiting for the YouTube page…",
      detected: "Detected: {name} ({code})",
      noPlayerTracks: "Could not read the player caption tracks",
      videoUnavailable: "The video is not playable",
      noTrack: "No usable source caption track was found",
      requestedKindMissing: "Detected {language}, but the selected caption type is unavailable",
      notTranslatable: "This caption track cannot be auto-translated",
      noPoToken: "The player did not return a valid caption request; play the video and retry",
      emptyResponse: "The caption response was empty",
    },
  };
  const TARGET_LANGUAGES = [
    ["zh-Hans", "简体中文", "Chinese (Simplified)"],
    ["zh-Hant", "繁體中文", "Chinese (Traditional)"],
    ["en", "英语", "English"],
    ["ja", "日语", "Japanese"],
    ["ko", "韩语", "Korean"],
    ["es", "西班牙语", "Spanish"],
    ["fr", "法语", "French"],
    ["de", "德语", "German"],
    ["pt", "葡萄牙语", "Portuguese"],
    ["ru", "俄语", "Russian"],
    ["ar", "阿拉伯语", "Arabic"],
    ["hi", "印地语", "Hindi"],
    ["it", "意大利语", "Italian"],
    ["id", "印度尼西亚语", "Indonesian"],
    ["vi", "越南语", "Vietnamese"],
    ["th", "泰语", "Thai"],
    ["tr", "土耳其语", "Turkish"],
    ["pl", "波兰语", "Polish"],
    ["nl", "荷兰语", "Dutch"],
    ["uk", "乌克兰语", "Ukrainian"],
  ];

  let settings = loadSettings();
  let generation = 0;
  let initializeTimer = 0;
  let lastVideoId = null;
  let currentStatus = {
    state: "waiting",
    message: message("waiting"),
    at: new Date().toISOString(),
  };
  let bilingualCues = [];
  let animationFrame = 0;
  let lastRenderedText = "";
  let ui = {};
  const captures = [];
  const originalFetch = window.fetch.bind(window);

  function loadSettings() {
    try {
      const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      return { ...DEFAULT_SETTINGS, ...stored, sourceLanguage: "auto" };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // The script continues with in-memory settings when storage is unavailable.
    }
  }

  function message(key, variables = {}) {
    const language = settings.uiLanguage === "en" ? "en" : "zh-CN";
    let value = MESSAGES[language][key] || MESSAGES["zh-CN"][key] || key;
    for (const [name, replacement] of Object.entries(variables)) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
    return value;
  }

  function normalizeUrl(value) {
    try {
      if (typeof value === "string") return new URL(value, location.href).toString();
      if (value instanceof Request) return value.url;
      if (value && typeof value.url === "string") return value.url;
    } catch {
      // Ignore non-URL request objects.
    }
    return "";
  }

  function recordTimedText(urlValue, text) {
    const rawUrl = normalizeUrl(urlValue);
    if (!rawUrl.includes("/api/timedtext") || !text) return;
    try {
      const url = new URL(rawUrl);
      const payload = JSON.parse(text);
      if (!Array.isArray(payload.events)) return;
      captures.push({
        url: url.toString(),
        params: Object.fromEntries(url.searchParams),
        payload,
        capturedAt: Date.now(),
      });
      if (captures.length > 40) captures.splice(0, captures.length - 40);
    } catch {
      // Empty or non-JSON timed-text responses are not useful.
    }
  }

  window.fetch = async function TwinCueFetch(input, init) {
    const response = await originalFetch(input, init);
    const url = normalizeUrl(input) || response.url;
    if (url.includes("/api/timedtext")) {
      void response.clone().text().then((text) => recordTimedText(url, text)).catch(() => {});
    }
    return response;
  };

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function TwinCueXhrOpen(method, url, ...rest) {
    this.__TwinCueUrl = normalizeUrl(url);
    return originalXhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function TwinCueXhrSend(...args) {
    if (this.__TwinCueUrl?.includes("/api/timedtext")) {
      this.addEventListener("load", () => {
        try {
          const text = this.responseType === "json" ? JSON.stringify(this.response) : this.responseText;
          recordTimedText(this.__TwinCueUrl, text);
        } catch {
          // Some response types do not expose responseText.
        }
      }, { once: true });
    }
    return originalXhrSend.apply(this, args);
  };

  function formattedText(value) {
    if (typeof value === "string") return value;
    return value?.simpleText ?? value?.runs?.map((run) => run.text || "").join("") ?? "";
  }

  function parseCues(payload) {
    if (!payload || !Array.isArray(payload.events)) return [];
    return payload.events
      .map((event) => {
        const startMs = Number(event.tStartMs || 0);
        const durationMs = Number(event.dDurationMs || 0);
        const text = (event.segs || [])
          .map((segment) => segment.utf8 || "")
          .join("")
          .replace(/\n/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return { startMs, durationMs, endMs: startMs + durationMs, text };
      })
      .filter((cue) => cue.text);
  }

  function alignCues(source, translated) {
    return source.map((sourceCue, index) => {
      let translatedCue = translated[index];
      if (!translatedCue || Math.abs(translatedCue.startMs - sourceCue.startMs) > 250) {
        translatedCue = translated.reduce((best, candidate) => {
          if (!best) return candidate;
          return Math.abs(candidate.startMs - sourceCue.startMs) < Math.abs(best.startMs - sourceCue.startMs)
            ? candidate
            : best;
        }, null);
        if (translatedCue && Math.abs(translatedCue.startMs - sourceCue.startMs) > 1000) {
          translatedCue = null;
        }
      }
      return {
        startMs: sourceCue.startMs,
        endMs: sourceCue.endMs,
        source: sourceCue.text,
        translated: translatedCue?.text || "",
      };
    });
  }

  function ensureGlobalStyle() {
    if (document.querySelector("#twincue-global-style")) return;
    const style = document.createElement("style");
    style.id = "twincue-global-style";
    style.textContent = "body.twincue-ready .ytp-caption-window-container{opacity:0!important}";
    document.documentElement.appendChild(style);
  }

  function ensureUi(player) {
    if (ui.host?.isConnected && ui.player === player) return;
    ui.host?.remove();
    ensureGlobalStyle();

    const host = document.createElement("div");
    host.id = "twincue-root";
    host.style.cssText = "position:absolute;inset:0;z-index:70;pointer-events:none";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
        :host { all: initial; }
        #overlay { position:absolute;left:5%;right:5%;bottom:11%;display:flex;flex-direction:column;align-items:center;gap:4px;pointer-events:none;text-align:center;font-family:Roboto,Arial,sans-serif;text-shadow:0 1px 2px #000,0 0 4px #000; }
        .line { max-width:92%;padding:2px 7px;border-radius:4px;color:#fff;background:rgba(0,0,0,.72);font-size:clamp(16px,2.2vw,30px);line-height:1.25; }
        #translated { color:#ffe875;font-size:clamp(15px,2vw,27px); }
        #settings-button { position:absolute;top:12px;left:12px;width:34px;height:28px;border:1px solid rgba(255,255,255,.5);border-radius:6px;color:#fff;background:rgba(0,0,0,.72);font:700 12px/26px Arial,sans-serif;text-align:center;cursor:pointer;pointer-events:auto;box-shadow:0 1px 4px rgba(0,0,0,.4); }
        #settings-button:hover { background:rgba(30,30,30,.95); }
        #status { position:absolute;top:12px;right:12px;max-width:50%;padding:5px 8px;border-radius:5px;color:#fff;background:rgba(0,0,0,.75);font:12px/1.3 Roboto,Arial,sans-serif;pointer-events:none; }
        #status[data-state="error"] { background:rgba(150,25,25,.92); }
        #panel { position:absolute;top:48px;left:12px;width:300px;box-sizing:border-box;padding:14px;border:1px solid #555;border-radius:8px;color:#eee;background:rgba(24,24,24,.97);font:13px/1.4 Arial,sans-serif;pointer-events:auto;box-shadow:0 5px 24px rgba(0,0,0,.55); }
        #panel[hidden] { display:none; }
        .panel-title { display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;font-size:16px;font-weight:700; }
        .close { border:0;color:#ddd;background:transparent;font-size:18px;cursor:pointer; }
        label { display:block;margin:9px 0 4px;font-weight:600; }
        .toggle { display:flex;align-items:center;gap:7px; }
        select { box-sizing:border-box;width:100%;padding:6px;border:1px solid #666;border-radius:5px;color:#eee;background:#303030; }
        .detected,.panel-status,.version { margin-top:8px;color:#bbb;font-size:12px;word-break:break-word; }
        .panel-status[data-state="error"] { color:#ff9d96; }
        .version { text-align:right;font-size:10px; }
    `;

    const overlay = document.createElement("div");
    overlay.id = "overlay";
    const sourceLine = document.createElement("div");
    sourceLine.id = "source";
    sourceLine.className = "line";
    sourceLine.hidden = true;
    const translatedLine = document.createElement("div");
    translatedLine.id = "translated";
    translatedLine.className = "line";
    translatedLine.hidden = true;
    overlay.append(sourceLine, translatedLine);

    const settingsButton = document.createElement("button");
    settingsButton.id = "settings-button";
    settingsButton.type = "button";
    settingsButton.textContent = "TC";
    const statusBadge = document.createElement("div");
    statusBadge.id = "status";
    const panel = document.createElement("div");
    panel.id = "panel";
    panel.hidden = true;
    shadow.append(style, overlay, settingsButton, statusBadge, panel);
    player.appendChild(host);

    ui = {
      player,
      host,
      shadow,
      sourceLine,
      translatedLine,
      settingsButton,
      statusBadge,
      panel,
    };
    ui.settingsButton.addEventListener("click", () => {
      ui.panel.hidden = !ui.panel.hidden;
      if (!ui.panel.hidden) renderSettingsPanel();
    });
    renderSettingsPanel();
    updateStatusUi();
  }

  function targetOptions() {
    const languageIndex = settings.uiLanguage === "en" ? 2 : 1;
    return TARGET_LANGUAGES.map(([code, zhName, enName]) => {
      const name = languageIndex === 2 ? enName : zhName;
      return [code, name];
    });
  }

  function renderSettingsPanel() {
    if (!ui.panel) return;
    const kindOptions = [
      ["any", message("kindAny")],
      ["manual", message("kindManual")],
      ["asr", message("kindAsr")],
    ];

    const createOption = (value, label, selectedValue) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = value === selectedValue;
      return option;
    };
    const createLabel = (text) => {
      const label = document.createElement("label");
      label.textContent = text;
      return label;
    };
    const createSelect = (settingName, options, selectedValue) => {
      const select = document.createElement("select");
      if (settingName) select.dataset.setting = settingName;
      select.append(...options.map(([value, label]) => createOption(value, label, selectedValue)));
      return select;
    };

    ui.settingsButton.title = message("settings");

    const titleRow = document.createElement("div");
    titleRow.className = "panel-title";
    const title = document.createElement("span");
    title.textContent = message("settings");
    const closeButton = document.createElement("button");
    closeButton.className = "close";
    closeButton.type = "button";
    closeButton.title = message("close");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", () => { ui.panel.hidden = true; });
    titleRow.append(title, closeButton);

    const uiLanguageSelect = createSelect(
      "uiLanguage",
      [["zh-CN", "中文"], ["en", "English"]],
      settings.uiLanguage,
    );

    const enabledLabel = document.createElement("label");
    enabledLabel.className = "toggle";
    const enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = settings.enabled;
    enabledInput.dataset.setting = "enabled";
    const enabledText = document.createElement("span");
    enabledText.textContent = message("enabled");
    enabledLabel.append(enabledInput, enabledText);

    const sourceLanguageSelect = createSelect(null, [["auto", message("autoDetect")]], "auto");
    sourceLanguageSelect.disabled = true;
    const detected = document.createElement("div");
    detected.className = "detected";
    const sourceKindSelect = createSelect("sourceKind", kindOptions, settings.sourceKind);
    const targetLanguageSelect = createSelect("targetLanguage", targetOptions(), settings.targetLanguage);
    const panelStatus = document.createElement("div");
    panelStatus.className = "panel-status";
    const version = document.createElement("div");
    version.className = "version";
    version.textContent = `TwinCue ${VERSION}`;

    ui.panel.replaceChildren(
      titleRow,
      createLabel(message("uiLanguage")),
      uiLanguageSelect,
      enabledLabel,
      createLabel(message("sourceLanguage")),
      sourceLanguageSelect,
      detected,
      createLabel(message("sourceKind")),
      sourceKindSelect,
      createLabel(message("targetLanguage")),
      targetLanguageSelect,
      panelStatus,
      version,
    );

    for (const field of ui.panel.querySelectorAll("[data-setting]")) {
      field.addEventListener("change", () => {
        const key = field.dataset.setting;
        const value = field.type === "checkbox" ? field.checked : field.value;
        setSettings({ [key]: value });
      });
    }
    updatePanelStatus();
  }

  function updatePanelStatus() {
    if (!ui.panel) return;
    const status = ui.panel.querySelector(".panel-status");
    const detected = ui.panel.querySelector(".detected");
    if (status) {
      status.textContent = currentStatus.message || "";
      status.dataset.state = currentStatus.state || "";
    }
    if (detected) {
      detected.textContent = currentStatus.sourceLanguage
        ? message("detected", {
            name: currentStatus.sourceName || currentStatus.sourceLanguage,
            code: currentStatus.sourceLanguage,
          })
        : "";
    }
  }

  function updateStatusUi() {
    if (!ui.statusBadge) return;
    ui.statusBadge.textContent = currentStatus.message || "";
    ui.statusBadge.dataset.state = currentStatus.state || "";
    ui.statusBadge.hidden = currentStatus.state === "ready";
    updatePanelStatus();
  }

  function publishStatus(state, text, extra = {}) {
    currentStatus = {
      state,
      message: text,
      videoId: new URL(location.href).searchParams.get("v"),
      at: new Date().toISOString(),
      ...extra,
    };
    updateStatusUi();
  }

  function resetCaptionState() {
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    bilingualCues = [];
    lastRenderedText = "";
    document.body?.classList.remove("twincue-ready");
    if (ui.sourceLine) {
      ui.sourceLine.textContent = "";
      ui.sourceLine.hidden = true;
    }
    if (ui.translatedLine) {
      ui.translatedLine.textContent = "";
      ui.translatedLine.hidden = true;
    }
  }

  function renderLoop(player, currentGeneration) {
    if (currentGeneration !== generation || !settings.enabled || !ui.host?.isConnected) return;
    const nowMs = Number(player.getCurrentTime?.() || 0) * 1000;
    const cue = bilingualCues.find((item) => item.startMs <= nowMs && nowMs <= item.endMs + 150);
    const renderKey = cue ? `${cue.source}\n${cue.translated}` : "";
    if (renderKey !== lastRenderedText) {
      lastRenderedText = renderKey;
      ui.sourceLine.textContent = cue?.source || "";
      ui.translatedLine.textContent = cue?.translated || "";
      ui.sourceLine.hidden = !cue?.source;
      ui.translatedLine.hidden = !cue?.translated;
    }
    animationFrame = requestAnimationFrame(() => renderLoop(player, currentGeneration));
  }

  function trackKindMatches(track, requestedKind) {
    if (requestedKind === "asr") return track.kind === "asr";
    if (requestedKind === "manual") return track.kind !== "asr";
    return true;
  }

  function detectSourceLanguage(renderer) {
    const tracks = renderer?.captionTracks || [];
    const audioTracks = renderer?.audioTracks || [];
    const audioTrack = audioTracks[renderer?.defaultAudioTrackIndex ?? 0];
    const audioTrackLanguage = typeof audioTrack?.audioTrackId === "string"
      ? audioTrack.audioTrackId.match(/^([a-z]{2,3}(?:-[A-Za-z]{2,4})?)(?:\.|$)/)?.[1]
      : null;
    if (audioTrackLanguage && tracks.some((track) => track.languageCode === audioTrackLanguage)) {
      return audioTrackLanguage;
    }
    const defaultIndex = audioTrack?.defaultCaptionTrackIndex;
    if (Number.isInteger(defaultIndex) && tracks[defaultIndex]) return tracks[defaultIndex].languageCode;
    const explicitlyDefault = tracks.find((track) => track.isDefault);
    if (explicitlyDefault) return explicitlyDefault.languageCode;
    const asrTrack = tracks.find((track) => track.kind === "asr");
    return asrTrack?.languageCode || tracks[0]?.languageCode || null;
  }

  function chooseTrack(renderer) {
    const tracks = renderer?.captionTracks || [];
    const sourceLanguage = detectSourceLanguage(renderer);
    if (!sourceLanguage) return { track: null, sourceLanguage: null };
    const matching = tracks.filter((track) => track.languageCode === sourceLanguage);
    if (settings.sourceKind !== "any") {
      return {
        track: matching.find((track) => trackKindMatches(track, settings.sourceKind)) || null,
        sourceLanguage,
      };
    }
    return {
      track: matching.find((track) => track.kind !== "asr") || matching[0] || null,
      sourceLanguage,
    };
  }

  function captureMatches(capture, track, targetLanguage) {
    if (capture.params.v !== lastVideoId || capture.params.lang !== track.languageCode) return false;
    if (track.kind === "asr" && capture.params.kind !== "asr") return false;
    if (track.kind !== "asr" && capture.params.kind === "asr") return false;
    return targetLanguage ? capture.params.tlang === targetLanguage : !capture.params.tlang;
  }

  async function waitForCapture(track, targetLanguage, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = [...captures].reverse().find((capture) => captureMatches(capture, track, targetLanguage));
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return [...captures].reverse().find((capture) => captureMatches(capture, track, targetLanguage)) || null;
  }

  async function deriveCapture(template, track, targetLanguage) {
    const url = new URL(template.url);
    url.searchParams.set("lang", track.languageCode);
    if (track.kind === "asr") url.searchParams.set("kind", "asr");
    if (targetLanguage) url.searchParams.set("tlang", targetLanguage);
    else url.searchParams.delete("tlang");
    url.searchParams.set("_twincue", Date.now().toString());
    const response = await originalFetch(url, { credentials: "include" });
    const text = await response.text();
    return {
      url: url.toString(),
      params: Object.fromEntries(url.searchParams),
      payload: JSON.parse(text),
      capturedAt: Date.now(),
    };
  }

  async function waitForPlayerResponse(videoId, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = window.ytInitialPlayerResponse;
      if (response?.videoDetails?.videoId === videoId) return response;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  }

  async function initialize() {
    const currentGeneration = ++generation;
    resetCaptionState();
    if (location.pathname !== "/watch") {
      ui.host?.remove();
      ui = {};
      return;
    }

    const videoId = new URL(location.href).searchParams.get("v");
    if (!videoId) return;
    lastVideoId = videoId;

    const player = await (async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const element = document.querySelector("#movie_player");
        if (element?.setOption) return element;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return null;
    })();
    if (!player || currentGeneration !== generation) return;
    ensureUi(player);

    if (!settings.enabled) {
      publishStatus("disabled", message("disabled"));
      return;
    }
    publishStatus("loading", message("loading"));

    try {
      const playerResponse = await waitForPlayerResponse(videoId);
      if (!playerResponse) throw new Error(message("noPlayerTracks"));
      if (playerResponse.playabilityStatus?.status !== "OK") {
        throw new Error(playerResponse.playabilityStatus?.reason || message("videoUnavailable"));
      }

      const renderer = playerResponse.captions?.playerCaptionsTracklistRenderer;
      const selected = chooseTrack(renderer);
      const track = selected.track;
      if (!track && selected.sourceLanguage && settings.sourceKind !== "any") {
        throw new Error(message("requestedKindMissing", { language: selected.sourceLanguage }));
      }
      if (!track) throw new Error(message("noTrack"));
      if (!track.isTranslatable) throw new Error(message("notTranslatable"));

      const trackOption = {
        languageCode: track.languageCode,
        kind: track.kind || "",
        vss_id: track.vssId,
      };
      player.loadModule?.("captions");
      player.setOption?.("captions", "track", {});
      player.setOption?.("captions", "track", trackOption);

      let sourceCapture = await waitForCapture(track, null, 8_000);
      if (currentGeneration !== generation) return;
      player.setOption?.("captions", "track", {
        ...trackOption,
        translationLanguage: { languageCode: settings.targetLanguage },
      });
      let translatedCapture = await waitForCapture(track, settings.targetLanguage, 15_000);
      if (currentGeneration !== generation) return;

      if (!sourceCapture && translatedCapture) sourceCapture = await deriveCapture(translatedCapture, track, null);
      if (!translatedCapture && sourceCapture) {
        translatedCapture = await deriveCapture(sourceCapture, track, settings.targetLanguage);
      }
      if (!sourceCapture || !translatedCapture) throw new Error(message("noPoToken"));

      const sourceCues = parseCues(sourceCapture.payload);
      const translatedCues = parseCues(translatedCapture.payload);
      if (!sourceCues.length || !translatedCues.length) throw new Error(message("emptyResponse"));
      if (currentGeneration !== generation) return;

      bilingualCues = alignCues(sourceCues, translatedCues);
      document.body?.classList.add("twincue-ready");
      publishStatus("ready", message("ready"), {
        sourceLanguage: track.languageCode,
        sourceKind: track.kind || "manual",
        autoDetectedSource: true,
        sourceCues: sourceCues.length,
        translatedCues: translatedCues.length,
        sourceName: formattedText(track.name),
      });
      renderLoop(player, currentGeneration);
    } catch (error) {
      if (currentGeneration !== generation) return;
      publishStatus("error", error instanceof Error ? error.message : String(error));
    }
  }

  function scheduleInitialize(delayMs = 100) {
    clearTimeout(initializeTimer);
    initializeTimer = setTimeout(() => void initialize(), delayMs);
  }

  function setSettings(patch) {
    settings = {
      ...settings,
      ...patch,
      sourceLanguage: "auto",
    };
    saveSettings();
    renderSettingsPanel();
    scheduleInitialize(0);
    return { ...settings };
  }

  window.TwinCue = Object.freeze({
    version: VERSION,
    getSettings: () => ({ ...settings }),
    getStatus: () => ({ ...currentStatus }),
    setSettings,
    openSettings: () => {
      if (ui.panel) {
        ui.panel.hidden = false;
        renderSettingsPanel();
      }
    },
    restart: () => scheduleInitialize(0),
  });

  document.addEventListener("yt-navigate-finish", () => scheduleInitialize());
  document.addEventListener("yt-page-data-updated", () => {
    const videoId = new URL(location.href).searchParams.get("v");
    if (videoId && videoId !== lastVideoId) scheduleInitialize();
  });
  scheduleInitialize();
})();
