const defaults = {
  enabled: true,
  sourceLanguage: "auto",
  sourceKind: "any",
  targetLanguage: "zh-Hans",
  uiLanguage: "zh-CN",
  settingsVersion: 2
};

const translations = {
  "zh-CN": {
    title: "TwinCue 原生双语字幕",
    uiLanguage: "界面语言",
    enabled: "启用双语字幕",
    sourceLanguage: "原字幕语言",
    autoDetect: "自动识别",
    detected: "已识别：{name}（{code}）",
    sourceKind: "原字幕类型",
    targetLanguage: "翻译语言",
    waiting: "等待 YouTube 页面状态…",
    saved: "设置已保存，正在重新加载字幕…",
    hint: "修改后会自动重新加载；必要时刷新或重新打开视频。",
    kindAny: "优先人工，自动回退",
    kindManual: "仅人工字幕",
    kindAsr: "仅自动生成字幕"
  },
  en: {
    title: "TwinCue Native Bilingual Subtitles",
    uiLanguage: "Interface language",
    enabled: "Enable bilingual subtitles",
    sourceLanguage: "Source subtitle language",
    autoDetect: "Auto-detect",
    detected: "Detected: {name} ({code})",
    sourceKind: "Source caption type",
    targetLanguage: "Translation language",
    waiting: "Waiting for the YouTube page…",
    saved: "Settings saved. Reloading subtitles…",
    hint: "Changes reload automatically; refresh or reopen the video if needed.",
    kindAny: "Prefer manual, fall back to auto",
    kindManual: "Manual captions only",
    kindAsr: "Auto-generated captions only"
  }
};

const targetLanguages = [
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
  ["uk", "乌克兰语", "Ukrainian"]
];

const fields = {
  enabled: document.querySelector("#enabled"),
  sourceLanguage: document.querySelector("#sourceLanguage"),
  sourceKind: document.querySelector("#sourceKind"),
  targetLanguage: document.querySelector("#targetLanguage"),
  uiLanguage: document.querySelector("#uiLanguage")
};
const statusElement = document.querySelector("#status");
const detectedElement = document.querySelector("#detected");
let lastStatus = null;

function text(key, variables = {}) {
  const language = fields.uiLanguage.value === "en" ? "en" : "zh-CN";
  let value = translations[language][key] || key;
  for (const [name, replacement] of Object.entries(variables)) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
}

function populateSelects() {
  const language = fields.uiLanguage.value === "en" ? "en" : "zh-CN";
  const selectedKind = fields.sourceKind.value || "any";
  fields.sourceKind.replaceChildren(
    new Option(text("kindAny"), "any"),
    new Option(text("kindManual"), "manual"),
    new Option(text("kindAsr"), "asr")
  );
  fields.sourceKind.value = selectedKind;

  const selectedTarget = fields.targetLanguage.value || "zh-Hans";
  fields.targetLanguage.replaceChildren(
    ...targetLanguages.map(([code, zhName, enName]) => new Option(language === "en" ? enName : zhName, code))
  );
  fields.targetLanguage.value = targetLanguages.some(([code]) => code === selectedTarget)
    ? selectedTarget
    : "zh-Hans";
}

function renderLanguage() {
  document.documentElement.lang = fields.uiLanguage.value === "en" ? "en" : "zh-CN";
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = text(element.dataset.i18n);
  }
  populateSelects();
  if (lastStatus) {
    statusElement.textContent = lastStatus.message || lastStatus.state;
    statusElement.dataset.state = lastStatus.state || "";
    detectedElement.textContent = lastStatus.sourceLanguage
      ? text("detected", {
          name: lastStatus.sourceName || lastStatus.sourceLanguage,
          code: lastStatus.sourceLanguage
        })
      : "";
  }
}

async function load() {
  const stored = await chrome.storage.sync.get(null);
  const values = { ...defaults, ...stored, sourceLanguage: "auto", settingsVersion: 2 };
  await chrome.storage.sync.set({ sourceLanguage: "auto", settingsVersion: 2 });
  fields.enabled.checked = values.enabled;
  fields.sourceLanguage.value = "auto";
  fields.uiLanguage.value = values.uiLanguage;
  populateSelects();
  fields.sourceKind.value = values.sourceKind;
  fields.targetLanguage.value = values.targetLanguage;
  ({ lastStatus } = await chrome.storage.local.get("lastStatus"));
  renderLanguage();
}

async function save() {
  await chrome.storage.sync.set({
    enabled: fields.enabled.checked,
    sourceLanguage: "auto",
    sourceKind: fields.sourceKind.value,
    targetLanguage: fields.targetLanguage.value,
    uiLanguage: fields.uiLanguage.value,
    settingsVersion: 2
  });
  renderLanguage();
  statusElement.textContent = text("saved");
  statusElement.dataset.state = "loading";
}

for (const field of Object.values(fields)) field.addEventListener("change", () => void save());
void load();
