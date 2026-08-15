import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profileDirectory = path.resolve(process.argv[2] ?? ".browser-profile/chrome");
const child = spawn(
  chromePath,
  [
    `--user-data-dir=${profileDirectory}`,
    "--profile-directory=Default",
    "https://www.youtube.com/",
  ],
  {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  },
);

child.unref();
console.log(`NORMAL_CHROME_STARTED pid=${child.pid} profile=${profileDirectory}`);
