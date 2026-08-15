(() => {
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

  async function publishConfig() {
    const root = document.documentElement;
    if (!root) {
      setTimeout(publishConfig, 0);
      return;
    }
    const stored = await chrome.storage.sync.get(null);
    const config = { ...defaults, ...stored };
    if (stored.settingsVersion !== 2) {
      config.sourceLanguage = "auto";
      config.settingsVersion = 2;
      await chrome.storage.sync.set({
        sourceLanguage: "auto",
        settingsVersion: 2
      });
    }
    root.setAttribute(CONFIG_ATTRIBUTE, JSON.stringify(config));
    root.dispatchEvent(new Event(CONFIG_EVENT));
  }

  function listenForStatus() {
    const root = document.documentElement;
    if (!root) {
      setTimeout(listenForStatus, 0);
      return;
    }
    root.addEventListener(STATUS_EVENT, () => {
      try {
        const status = JSON.parse(root.getAttribute(STATUS_ATTRIBUTE) || "null");
        if (status) void chrome.storage.local.set({ lastStatus: status });
      } catch {
        // A malformed page event must not break the content bridge.
      }
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && Object.keys(changes).some((key) => key in defaults)) {
      void publishConfig();
    }
  });

  listenForStatus();
  void publishConfig();
})();
