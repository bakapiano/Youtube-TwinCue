export function formattedText(value) {
  if (typeof value === "string") return value;
  return value?.simpleText ?? value?.runs?.map((run) => run.text ?? "").join("") ?? "";
}

export function selectCaptionTrack(tracks, sourceLanguage) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;

  return (
    tracks.find((track) => track.languageCode === sourceLanguage && track.kind !== "asr") ??
    tracks.find((track) => track.languageCode === sourceLanguage) ??
    tracks.find((track) => track.vssId?.includes(`.${sourceLanguage}`)) ??
    tracks[0]
  );
}

export function buildTimedTextUrl(baseUrl, { targetLanguage = null, format = "json3" } = {}) {
  const url = new URL(baseUrl);
  url.searchParams.set("fmt", format);

  if (targetLanguage) url.searchParams.set("tlang", targetLanguage);
  else url.searchParams.delete("tlang");

  return url.toString();
}

export function parseJson3Captions(payload) {
  if (!payload || !Array.isArray(payload.events)) return [];

  return payload.events
    .map((event) => {
      const startMs = Number(event.tStartMs ?? 0);
      const durationMs = Number(event.dDurationMs ?? 0);
      const text = (event.segs ?? [])
        .map((segment) => segment.utf8 ?? "")
        .join("")
        .replace(/\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      return {
        startMs,
        durationMs,
        endMs: startMs + durationMs,
        text,
      };
    })
    .filter((cue) => cue.text);
}

function nearestCue(cues, startMs, preferredIndex) {
  const preferred = cues[preferredIndex];
  if (preferred && Math.abs(preferred.startMs - startMs) <= 250) return preferred;

  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const cue of cues) {
    const distance = Math.abs(cue.startMs - startMs);
    if (distance < bestDistance) {
      best = cue;
      bestDistance = distance;
    }
  }
  return bestDistance <= 1_000 ? best : null;
}

export function alignBilingualCues(sourceCues, translatedCues) {
  return sourceCues.map((source, index) => {
    const translated = nearestCue(translatedCues, source.startMs, index);
    return {
      startMs: source.startMs,
      durationMs: source.durationMs,
      endMs: source.endMs,
      source: source.text,
      translated: translated?.text ?? "",
    };
  });
}
