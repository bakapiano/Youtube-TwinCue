(() => {
  if (window.__ytNativeBilingualInstalled) return;
  window.__ytNativeBilingualInstalled = true;

  const CONFIG_ATTRIBUTE = "data-yt-native-bilingual-config";
  const CONFIG_EVENT = "yt-native-bilingual-config";
  const STATUS_ATTRIBUTE = "data-yt-native-bilingual-status";
  const STATUS_EVENT = "yt-native-bilingual-status";
  const defaults = {
    enabled: true,
    sourceLanguage: "auto",
    sourceKind: "any",
    targetLanguage: "zh-Hans",
    uiLanguage: "zh-CN",
    settingsVersion: 2
  };
  const messages = {
    "zh-CN": {
      loading: "双语字幕加载中…",
      ready: "双语字幕已就绪",
      noPlayerTracks: "未取得播放器字幕轨道",
      videoUnavailable: "视频不可播放",
      noTrack: "没有可用的原字幕轨道",
      requestedKindMissing: "自动识别到 {language}，但没有所选类型的字幕",
      notTranslatable: "该字幕轨道不支持自动翻译",
      noPoToken: "播放器未返回有效 PoToken 字幕请求；请播放视频后重试",
      emptyResponse: "字幕响应为空"
    },
    en: {
      loading: "Loading bilingual subtitles…",
      ready: "Bilingual subtitles ready",
      noPlayerTracks: "Could not read the player caption tracks",
      videoUnavailable: "The video is not playable",
      noTrack: "No usable source caption track was found",
      requestedKindMissing: "Detected {language}, but the selected caption type is unavailable",
      notTranslatable: "This caption track cannot be auto-translated",
      noPoToken: "The player did not return a valid PoToken caption request; play the video and retry",
      emptyResponse: "The caption response was empty"
    }
  };

  let config = { ...defaults };
  let generation = 0;
  let lastVideoId = null;
  let overlay = null;
  let sourceLine = null;
  let translatedLine = null;
  let statusBadge = null;
  let animationFrame = 0;
  let bilingualCues = [];
  let lastRenderedText = "";
  const captures = [];
  const originalFetch = window.fetch.bind(window);

  function message(key, variables = {}) {
    const language = config.uiLanguage === "en" ? "en" : "zh-CN";
    let value = messages[language][key] || messages["zh-CN"][key] || key;
    for (const [name, replacement] of Object.entries(variables)) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
    return value;
  }

  function rootElement() {
    return document.documentElement;
  }

  function publishStatus(state, message, extra = {}) {
    const status = {
      state,
      message,
      videoId: new URL(location.href).searchParams.get("v"),
      at: new Date().toISOString(),
      ...extra
    };
    const root = rootElement();
    if (root) {
      root.setAttribute(STATUS_ATTRIBUTE, JSON.stringify(status));
      root.dispatchEvent(new Event(STATUS_EVENT));
    }
    if (statusBadge) {
      statusBadge.textContent = message;
      statusBadge.dataset.state = state;
      statusBadge.hidden = state === "ready";
    }
  }

  function normalizeUrl(value) {
    try {
      if (typeof value === "string") return new URL(value, location.href).toString();
      if (value instanceof Request) return value.url;
      if (value && typeof value.url === "string") return value.url;
    } catch {
      // Ignore non-URL fetch inputs.
    }
    return "";
  }

  function recordTimedText(urlValue, text) {
    const rawUrl = normalizeUrl(urlValue);
    if (!rawUrl || !rawUrl.includes("/api/timedtext") || !text) return;
    try {
      const url = new URL(rawUrl);
      const payload = JSON.parse(text);
      if (!Array.isArray(payload.events)) return;
      captures.push({
        url: url.toString(),
        params: Object.fromEntries(url.searchParams),
        payload,
        capturedAt: Date.now()
      });
      if (captures.length > 40) captures.splice(0, captures.length - 40);
    } catch {
      // Empty or non-JSON timedtext responses are not usable.
    }
  }

  window.fetch = async function patchedFetch(input, init) {
    const response = await originalFetch(input, init);
    const url = normalizeUrl(input) || response.url;
    if (url.includes("/api/timedtext")) {
      void response.clone().text().then((text) => recordTimedText(url, text)).catch(() => {});
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__ytNativeBilingualUrl = normalizeUrl(url);
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    if (this.__ytNativeBilingualUrl?.includes("/api/timedtext")) {
      this.addEventListener("load", () => {
        try {
          const text = this.responseType === "json"
            ? JSON.stringify(this.response)
            : this.responseText;
          recordTimedText(this.__ytNativeBilingualUrl, text);
        } catch {
          // Some response types do not expose responseText.
        }
      }, { once: true });
    }
    return originalSend.apply(this, args);
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
        translated: translatedCue?.text || ""
      };
    });
  }

  function ensureOverlay(player) {
    if (overlay?.isConnected) return;
    if (!document.querySelector("#yt-native-bilingual-style")) {
      const style = document.createElement("style");
      style.id = "yt-native-bilingual-style";
      style.textContent = `
      #yt-native-bilingual-overlay {
        position: absolute;
        z-index: 70;
        left: 5%;
        right: 5%;
        bottom: 11%;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        pointer-events: none;
        text-align: center;
        font-family: Roboto, Arial, sans-serif;
        text-shadow: 0 1px 2px #000, 0 0 4px #000;
      }
      #yt-native-bilingual-overlay .yt-native-bilingual-line {
        max-width: 92%;
        padding: 2px 7px;
        border-radius: 4px;
        color: #fff;
        background: rgba(0, 0, 0, .72);
        font-size: clamp(16px, 2.2vw, 30px);
        line-height: 1.25;
      }
      #yt-native-bilingual-overlay .yt-native-bilingual-translated {
        color: #ffe875;
        font-size: clamp(15px, 2vw, 27px);
      }
      #yt-native-bilingual-status {
        position: absolute;
        z-index: 72;
        top: 12px;
        right: 12px;
        padding: 5px 8px;
        border-radius: 5px;
        color: #fff;
        background: rgba(0, 0, 0, .75);
        font: 12px/1.3 Roboto, Arial, sans-serif;
        pointer-events: none;
      }
      #yt-native-bilingual-status[data-state="error"] { background: rgba(150, 25, 25, .9); }
      body.yt-native-bilingual-ready .ytp-caption-window-container { opacity: 0 !important; }
      `;
      document.documentElement.appendChild(style);
    }

    overlay = document.createElement("div");
    overlay.id = "yt-native-bilingual-overlay";
    sourceLine = document.createElement("div");
    sourceLine.className = "yt-native-bilingual-line yt-native-bilingual-source";
    translatedLine = document.createElement("div");
    translatedLine.className = "yt-native-bilingual-line yt-native-bilingual-translated";
    statusBadge = document.createElement("div");
    statusBadge.id = "yt-native-bilingual-status";
    overlay.append(sourceLine, translatedLine, statusBadge);
    player.appendChild(overlay);
  }

  function clearOverlay() {
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    bilingualCues = [];
    lastRenderedText = "";
    overlay?.remove();
    document.body?.classList.remove("yt-native-bilingual-ready");
    overlay = sourceLine = translatedLine = statusBadge = null;
  }

  function renderLoop(player, currentGeneration) {
    if (currentGeneration !== generation || !config.enabled || !overlay?.isConnected) return;
    const nowMs = Number(player.getCurrentTime?.() || 0) * 1000;
    const cue = bilingualCues.find((item) => item.startMs <= nowMs && nowMs <= item.endMs + 150);
    const renderKey = cue ? `${cue.source}\n${cue.translated}` : "";
    if (renderKey !== lastRenderedText) {
      lastRenderedText = renderKey;
      sourceLine.textContent = cue?.source || "";
      translatedLine.textContent = cue?.translated || "";
      sourceLine.hidden = !cue?.source;
      translatedLine.hidden = !cue?.translated;
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
    if (Number.isInteger(defaultIndex) && tracks[defaultIndex]) {
      return tracks[defaultIndex].languageCode;
    }
    const explicitlyDefault = tracks.find((track) => track.isDefault);
    if (explicitlyDefault) return explicitlyDefault.languageCode;
    const asrTrack = tracks.find((track) => track.kind === "asr");
    if (asrTrack) return asrTrack.languageCode;
    return tracks[0]?.languageCode || null;
  }

  function chooseTrack(renderer) {
    const tracks = renderer?.captionTracks || [];
    const sourceLanguage = config.sourceLanguage === "auto"
      ? detectSourceLanguage(renderer)
      : config.sourceLanguage;
    if (!sourceLanguage) return { track: null, sourceLanguage: null };
    const matching = tracks.filter((track) => track.languageCode === sourceLanguage);
    if (config.sourceKind !== "any") {
      return {
        track: matching.find((track) => trackKindMatches(track, config.sourceKind)) || null,
        sourceLanguage
      };
    }
    return {
      track: matching.find((track) => track.kind !== "asr") || matching[0] || null,
      sourceLanguage
    };
  }

  function captureMatches(capture, track, targetLanguage) {
    if (capture.params.v !== lastVideoId || capture.params.lang !== track.languageCode) return false;
    if (track.kind === "asr" && capture.params.kind !== "asr") return false;
    if (track.kind !== "asr" && capture.params.kind === "asr") return false;
    return targetLanguage
      ? capture.params.tlang === targetLanguage
      : !capture.params.tlang;
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
    url.searchParams.set("_yt_native_bilingual", Date.now().toString());
    const response = await originalFetch(url, { credentials: "include" });
    const text = await response.text();
    const payload = JSON.parse(text);
    return {
      url: url.toString(),
      params: Object.fromEntries(url.searchParams),
      payload,
      capturedAt: Date.now()
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
    clearOverlay();
    if (!config.enabled || location.pathname !== "/watch") return;

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
    ensureOverlay(player);
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
      if (!track && selected.sourceLanguage && config.sourceKind !== "any") {
        throw new Error(message("requestedKindMissing", { language: selected.sourceLanguage }));
      }
      if (!track) throw new Error(message("noTrack"));
      if (!track.isTranslatable) throw new Error(message("notTranslatable"));

      const trackOption = {
        languageCode: track.languageCode,
        kind: track.kind || "",
        vss_id: track.vssId
      };
      player.loadModule?.("captions");
      player.setOption?.("captions", "track", {});
      player.setOption?.("captions", "track", trackOption);

      let sourceCapture = await waitForCapture(track, null, 8_000);
      player.setOption?.("captions", "track", {
        ...trackOption,
        translationLanguage: { languageCode: config.targetLanguage }
      });
      let translatedCapture = await waitForCapture(track, config.targetLanguage, 15_000);

      if (!sourceCapture && translatedCapture) {
        sourceCapture = await deriveCapture(translatedCapture, track, null);
      }
      if (!translatedCapture && sourceCapture) {
        translatedCapture = await deriveCapture(sourceCapture, track, config.targetLanguage);
      }
      if (!sourceCapture || !translatedCapture) {
        throw new Error(message("noPoToken"));
      }

      const sourceCues = parseCues(sourceCapture.payload);
      const translatedCues = parseCues(translatedCapture.payload);
      if (!sourceCues.length || !translatedCues.length) throw new Error(message("emptyResponse"));
      if (currentGeneration !== generation) return;

      bilingualCues = alignCues(sourceCues, translatedCues);
      document.body?.classList.add("yt-native-bilingual-ready");
      publishStatus("ready", message("ready"), {
        sourceLanguage: track.languageCode,
        sourceKind: track.kind || "manual",
        autoDetectedSource: config.sourceLanguage === "auto",
        sourceCues: sourceCues.length,
        translatedCues: translatedCues.length,
        sourceName: formattedText(track.name)
      });
      renderLoop(player, currentGeneration);
    } catch (error) {
      if (currentGeneration !== generation) return;
      publishStatus("error", error instanceof Error ? error.message : String(error));
    }
  }

  function readConfig() {
    const root = rootElement();
    if (!root) return;
    try {
      config = { ...defaults, ...JSON.parse(root.getAttribute(CONFIG_ATTRIBUTE) || "{}") };
    } catch {
      config = { ...defaults };
    }
    void initialize();
  }

  function installRootListeners() {
    const root = rootElement();
    if (!root) {
      setTimeout(installRootListeners, 0);
      return;
    }
    root.addEventListener(CONFIG_EVENT, readConfig);
    readConfig();
  }

  document.addEventListener("yt-navigate-finish", () => void initialize());
  document.addEventListener("yt-page-data-updated", () => {
    const currentVideoId = new URL(location.href).searchParams.get("v");
    if (currentVideoId && currentVideoId !== lastVideoId) void initialize();
  });
  installRootListeners();
})();
