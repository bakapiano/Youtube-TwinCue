import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseJson3Captions } from "../src/captions.mjs";

const cases = [
  {
    name: "manual",
    stem: "aircAruvnKk-en-manual-zh-Hans",
    expectedKind: "manual",
  },
  {
    name: "asr",
    stem: "txqiwrbYGrs-en-asr-zh-Hans",
    expectedKind: "asr",
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

const summaries = [];
for (const item of cases) {
  const base = path.resolve("artifacts");
  const report = await readJson(path.join(base, `${item.stem}-report.json`));
  const source = await readJson(path.join(base, `${item.stem}-source.json`));
  const translated = await readJson(path.join(base, `${item.stem}-translated.json`));
  const bilingual = await readJson(path.join(base, `${item.stem}-bilingual.json`));
  const sourceCues = parseJson3Captions(source);
  const translatedCues = parseJson3Captions(translated);
  const translatedCoverage = bilingual.filter((cue) => cue.translated).length / bilingual.length;

  assert(report.method === "normal Chrome + Playwright connectOverCDP", `${item.name}: wrong method`);
  assert(report.browser.navigatorWebdriver === false, `${item.name}: webdriver must be false`);
  assert(report.browser.loggedIn === true, `${item.name}: expected logged-in profile`);
  assert(report.playerStatus === "OK", `${item.name}: player status is not OK`);
  assert(report.selectedTrack.kind === item.expectedKind, `${item.name}: wrong source kind`);
  assert(report.source.status === 200 && report.source.bytes > 0, `${item.name}: empty source response`);
  assert(report.translated.status === 200 && report.translated.bytes > 0, `${item.name}: empty translated response`);
  assert(report.source.hasPoToken, `${item.name}: source request did not retain PoToken`);
  assert(report.translated.hasPoToken, `${item.name}: translated request did not retain PoToken`);
  assert(sourceCues.length === report.source.cueCount, `${item.name}: source cue count mismatch`);
  assert(translatedCues.length === report.translated.cueCount, `${item.name}: translated cue count mismatch`);
  assert(bilingual.length === report.bilingualCueCount, `${item.name}: bilingual cue count mismatch`);
  assert(translatedCoverage >= 0.8, `${item.name}: translated alignment coverage is below 80%`);

  summaries.push({
    case: item.name,
    videoId: report.video.id,
    sourceKind: report.selectedTrack.kind,
    sourceCues: sourceCues.length,
    translatedCues: translatedCues.length,
    translatedCoverage: Number(translatedCoverage.toFixed(3)),
  });
}

console.log(JSON.stringify({ verified: true, cases: summaries }, null, 2));
