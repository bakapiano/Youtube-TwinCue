# TwinCue

[English](README.md) | [简体中文](README.zh-CN.md)

TwinCue 是一个 Manifest V3 Chrome 扩展，可在 YouTube 视频上同步显示两行字幕：视频原字幕，以及由 YouTube 自动翻译生成的第二语言字幕。

它同时支持创作者提供的人工字幕和 YouTube 自动生成字幕（ASR）。扩展会从当前音轨识别原语言，不会再把用户上次选择的翻译字幕误认为原字幕。

> TwinCue 是独立项目，与 YouTube 或 Google 无隶属或背书关系。

## 功能

- 根据当前 YouTube 音轨自动识别原字幕语言
- 支持人工字幕与自动生成字幕（ASR）
- 使用 YouTube 自带自动翻译
- 同步显示原文和译文两行字幕
- 可选择“优先人工 / 仅人工 / 仅自动生成字幕”
- 翻译语言下拉框包含 20 种常用语言
- 扩展界面支持中文和 English 切换
- 设置仅保存在本机或 Chrome Sync；没有 TwinCue 服务器或统计代码

## 安装到 Chrome

1. 下载或克隆本仓库。
2. 打开 `chrome://extensions`。
3. 开启右上角的“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择仓库内的 `extension` 文件夹。
6. 刷新已打开的 YouTube 页面。

修改源码后，请在 `chrome://extensions` 中点击扩展卡片上的“重新加载”，然后刷新 YouTube。

## 使用

1. 打开一个带字幕的 YouTube 视频。
2. 点击工具栏中的 TwinCue 图标。
3. 选择：
   - 原字幕类型：优先人工 / 仅人工 / 仅自动生成
   - 翻译语言
   - 界面语言：中文 / English
4. 播放视频。TwinCue 会自动识别原字幕语言并显示双语字幕。

扩展弹窗会显示识别到的原语言，以及当前加载或错误状态。

## 工作原理

目前 YouTube 的 timed-text 字幕请求需要短时有效的 Proof-of-Origin Token（PoToken）。仅获取 `captionTracks[].baseUrl` 后直接请求，可能出现 HTTP 200 但正文为空。

因此 TwinCue 在 YouTube 页面内执行：

1. 从 `ytInitialPlayerResponse` 读取字幕轨道元数据。
2. 从当前 `audioTrackId` 识别原语言。
3. 让 YouTube 播放器选择原字幕和目标翻译字幕。
4. 捕获播放器实际发出的 `/api/timedtext?...&pot=...` JSON3 响应。
5. 对齐时间轴并绘制双语字幕覆盖层。

PoToken 与签名字幕 URL 都会过期，扩展不会把它们视为长期有效地址。

## 权限与隐私

TwinCue 只申请：

- `storage`：保存扩展设置与最近状态
- `https://www.youtube.com/*`：在 YouTube 页面运行字幕集成

TwinCue 没有后端、统计、广告或远程代码。字幕文本只在 YouTube 页面内处理，不会发送到 TwinCue 服务。

## 开发

环境要求：

- Node.js 22+
- Google Chrome
- Windows Profile 辅助脚本需要 PowerShell

安装依赖：

```powershell
npm install
npx playwright install chromium
```

运行单元测试与扩展集成测试：

```powershell
npm test
npm run test:extension
```

运行底层字幕探针：

```powershell
node scripts/probe-cdp.mjs --video=aircAruvnKk --source=en --kind=manual --target=zh-Hans
```

探针会把诊断结果写入已忽略的 `artifacts/`。本机完成相应人工字幕和 ASR 探针后，可运行 `npm run verify` 校验产物。

## 已验证场景

| 来源 | 轨道 | 原字幕 | 自动翻译 | 对齐覆盖率 |
|---|---|---:|---:|---:|
| 创作者提供的英语字幕 | `en / manual` | 286 | 284 | 99.3% |
| YouTube 自动生成英语字幕 | `en / asr` | 27 | 26 | 96.3% |

扩展集成测试还覆盖了原语言自动识别、timed-text 请求捕获、双语绘制与原生字幕隐藏。

## 目录结构

```text
extension/   Chrome 扩展源码
scripts/     Playwright/CDP 探针与测试工具
src/         字幕解析与对齐模块
test/        单元测试
```

## 限制

- TwinCue 依赖未公开的 YouTube 播放器内部接口，未来可能变化。
- 视频必须提供可翻译的字幕轨道。
- 翻译质量由 YouTube 决定。
- 以“加载已解压”方式安装后，源码更新需要手动重新加载扩展。
