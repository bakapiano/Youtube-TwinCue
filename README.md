# TwinCue

[English](README.md) | [简体中文](README.zh-CN.md)

TwinCue is a Manifest V3 Chrome extension that displays two synchronized subtitle lines on YouTube: the video's native caption track and a YouTube auto-translated track.

It works with both creator-provided captions and YouTube auto-generated captions (ASR). Caption language is detected from the active audio track, so a previously selected translated caption is not mistaken for the source language.

> TwinCue is an independent project and is not affiliated with or endorsed by YouTube or Google.

## Features

- Automatically detects the source language from the active YouTube audio track
- Supports manual and auto-generated (ASR) captions
- Uses YouTube's own auto-translation
- Renders synchronized source and translated subtitle lines
- Lets you prefer manual captions, require manual captions, or require ASR
- Offers a target-language dropdown with 20 common languages
- Provides selectable English and Simplified Chinese interfaces
- Stores settings locally/with Chrome Sync; no TwinCue server or analytics

## Install in Chrome

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the repository's `extension` directory.
6. Refresh an open YouTube tab.

After editing the source, click the extension card's **Reload** button on `chrome://extensions`, then refresh YouTube.

## Use

1. Open a YouTube video that has captions.
2. Click the TwinCue toolbar icon.
3. Choose:
   - Source caption type: prefer manual / manual only / auto-generated only
   - Translation language
   - Interface language: English / 中文
4. Play the video. TwinCue automatically detects the source language and displays both lines.

The popup reports the detected source language and current loading/error state.

## How it works

Modern YouTube timed-text requests require a short-lived Proof-of-Origin token (PoToken). Directly fetching `captionTracks[].baseUrl` can return HTTP 200 with an empty body.

TwinCue therefore runs in the YouTube page and:

1. Reads caption metadata from `ytInitialPlayerResponse`.
2. Detects the source language from the active `audioTrackId`.
3. Asks the YouTube player to select the source and translated tracks.
4. Captures the player's valid `/api/timedtext?...&pot=...` JSON3 responses.
5. Aligns the cue timestamps and renders a bilingual overlay.

PoTokens and signed caption URLs expire and are never treated as permanent URLs.

## Permissions and privacy

TwinCue requests only:

- `storage`: saves extension settings and the latest status
- `https://www.youtube.com/*`: runs the subtitle integration on YouTube

TwinCue has no backend, analytics, advertising, or remote code. Caption text stays in the YouTube page and is not sent to a TwinCue service.

## Development

Requirements:

- Node.js 22+
- Google Chrome
- PowerShell for the Windows profile helper scripts

Install dependencies:

```powershell
npm install
npx playwright install chromium
```

Run unit and extension integration tests:

```powershell
npm test
npm run test:extension
```

Run the low-level caption probe:

```powershell
node scripts/probe-cdp.mjs --video=aircAruvnKk --source=en --kind=manual --target=zh-Hans
```

The probe stores ignored diagnostic artifacts in `artifacts/`. `npm run verify` validates the manual-caption and ASR artifacts after the corresponding probes have been run locally.

## Verified cases

| Source | Track | Source cues | Translated cues | Alignment coverage |
|---|---|---:|---:|---:|
| Creator-provided English | `en / manual` | 286 | 284 | 99.3% |
| YouTube auto-generated English | `en / asr` | 27 | 26 | 96.3% |

The extension integration test also verifies source-language auto-detection, timed-text interception, bilingual rendering, and native-caption suppression.

## Project layout

```text
extension/   Chrome extension source
scripts/     Playwright/CDP probes and test helpers
src/         Caption parsing and alignment helpers
test/        Unit tests
```

## Limitations

- TwinCue depends on undocumented YouTube player internals that may change.
- A video must expose a translatable caption track.
- Translation quality is determined by YouTube.
- Unpacked extensions must be reloaded manually after source changes.
