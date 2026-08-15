import { spawn } from "node:child_process";
import path from "node:path";

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const extensionPath = path.resolve("extension");

const chrome = spawn(chromePath, ["chrome://extensions/"], {
  detached: true,
  stdio: "ignore",
  windowsHide: false,
});
chrome.unref();

const explorer = spawn("explorer.exe", [extensionPath], {
  detached: true,
  stdio: "ignore",
  windowsHide: false,
});
explorer.unref();

console.log(`Chrome extension page opened. Load unpacked: ${extensionPath}`);
