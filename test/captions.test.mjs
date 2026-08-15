import test from "node:test";
import assert from "node:assert/strict";
import {
  alignBilingualCues,
  buildTimedTextUrl,
  formattedText,
  parseJson3Captions,
  selectCaptionTrack,
} from "../src/captions.mjs";

test("buildTimedTextUrl preserves signed parameters and adds translation", () => {
  const result = new URL(
    buildTimedTextUrl("https://www.youtube.com/api/timedtext?v=abc&lang=en&sig=xyz", {
      targetLanguage: "zh-Hans",
    }),
  );

  assert.equal(result.searchParams.get("v"), "abc");
  assert.equal(result.searchParams.get("sig"), "xyz");
  assert.equal(result.searchParams.get("fmt"), "json3");
  assert.equal(result.searchParams.get("tlang"), "zh-Hans");
});

test("selectCaptionTrack prefers a manual track over ASR", () => {
  const tracks = [
    { languageCode: "en", kind: "asr", vssId: "a.en" },
    { languageCode: "en", vssId: ".en" },
  ];
  assert.equal(selectCaptionTrack(tracks, "en"), tracks[1]);
});

test("parseJson3Captions normalizes segments and timestamps", () => {
  const cues = parseJson3Captions({
    events: [
      { tStartMs: 1200, dDurationMs: 800, segs: [{ utf8: "Hello" }, { utf8: "\nworld" }] },
      { tStartMs: 2000, dDurationMs: 200, segs: [] },
    ],
  });

  assert.deepEqual(cues, [
    { startMs: 1200, durationMs: 800, endMs: 2000, text: "Hello world" },
  ]);
});

test("alignBilingualCues aligns small timestamp differences", () => {
  const result = alignBilingualCues(
    [{ startMs: 1000, durationMs: 900, endMs: 1900, text: "Hello" }],
    [{ startMs: 1080, durationMs: 900, endMs: 1980, text: "你好" }],
  );
  assert.equal(result[0].translated, "你好");
});

test("formattedText supports YouTube formatted strings", () => {
  assert.equal(formattedText({ runs: [{ text: "Chinese" }, { text: " (Simplified)" }] }), "Chinese (Simplified)");
});
