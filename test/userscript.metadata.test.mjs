import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile("userscript/TwinCue.user.js", "utf8");
const metadata = source.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/)?.[0] || "";

test("userscript metadata supports direct installation and GitHub updates", () => {
  assert.match(metadata, /@name\s+TwinCue/);
  assert.match(metadata, /@version\s+0\.3\.3/);
  assert.match(metadata, /@match\s+https:\/\/www\.youtube\.com\/\*/);
  assert.match(metadata, /@run-at\s+document-start/);
  assert.match(metadata, /@grant\s+none/);
  assert.match(metadata, /@downloadURL\s+https:\/\/raw\.githubusercontent\.com\/bakapiano\/Youtube-TwinCue\/main\/userscript\/TwinCue\.user\.js/);
  assert.match(metadata, /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/bakapiano\/Youtube-TwinCue\/main\/userscript\/TwinCue\.user\.js/);
});

test("userscript has no Chrome extension API dependency", () => {
  assert.doesNotMatch(source, /\bchrome\s*\./);
  assert.doesNotMatch(source, /chrome\.storage|chrome\.runtime|chrome\.tabs/);
});
