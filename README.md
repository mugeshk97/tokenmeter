# Tokenmeter

_Formerly "AI Usage Widget". On first start, Tokenmeter copies your settings from `~/.config/AI Usage Widget` and replaces the old start-at-login entry. Saved keys may need re-entering, because the system keyring entry is tied to the app name._

A small always-on-top Electron widget for Linux that keeps your AI usage visible on the desktop:

| Card | Source | Needs | Shows |
|---|---|---|---|
| **Claude Code** | local transcripts `~/.claude/projects/**/*.jsonl` | nothing | tokens in the current 5-hour session + time until it resets, tokens today, top model, hourly chart |
| **Codex** | local session logs `~/.codex/sessions/**/rollout-*.jsonl` | nothing | 5-hour and weekly limit % with reset countdowns, tokens today, plan |
| **Grok CLI** | local session logs `~/.grok/sessions/**/updates.jsonl` | nothing | tokens today, cost today and month to date (as reported by the CLI), top model, cache-hit %, hourly chart |
| **GitHub Copilot** | GitHub `copilot_internal/user` endpoint | GitHub token (output of `gh auth token`) | premium requests / chat / completions quota % with reset date, plan |
| **Gemini CLI** | saved chats `~/.gemini/tmp/*/chats/session-*.json` | nothing | tokens today and last 7 days, top model, hourly chart |
| **Claude API** | Anthropic Usage & Cost Admin API | Admin API key `sk-ant-admin01-…` | month-to-date cost, today, 24h tokens, cache-hit %, optional budget bar |
| **xAI API** | xAI Management API | Management Key + Team ID | month-to-date spend, today, top model, postpaid bill vs spending limit, prepaid credit |
| **OpenAI API** (off by default) | OpenAI org Costs/Usage API | Admin key `sk-admin-…` | month-to-date cost, 24h tokens and requests (this is where Codex spend lands if Codex runs on an API key) |

The local cards refresh every minute (cached, only changed files are re-read). The API cards refresh every 5 minutes by default (configurable, minimum 1).

## Run it

```bash
cd ai-usage-widget   # project folder
npm install
npm start          # run from source
npm run demo       # preview the UI with sample numbers
npm test           # provider/parser tests (no network)
```

## Install as an app

```bash
npm run dist
# → dist/tokenmeter-1.0.0-x86_64.AppImage
# → dist/tokenmeter-1.0.0-amd64.deb

sudo apt install ./dist/tokenmeter-1.0.0-amd64.deb
# or: chmod +x dist/*.AppImage && ./dist/tokenmeter-1.0.0-x86_64.AppImage
```

Then tick **Start at login** in Settings (or the tray menu). This writes `~/.config/autostart/tokenmeter.desktop`.

## Getting the keys

- **Claude API:** Console → Settings → Admin Keys. You need an organization account; individual accounts can't create Admin keys.
- **Grok:** console.x.ai → Settings → Management Keys. Your account needs "Management Keys Read + Write". The Team ID is under Team settings.
- **OpenAI:** platform.openai.com → Settings → Organization → Admin keys.
- **GitHub Copilot:** run `gh auth token` and paste the output (`gho_…`). That token is known to work with the quota endpoint. Personal access tokens may also work but haven't been tested. The token is only sent to `api.github.com`.

Paste them in **Settings** (the gear icon). Keys are:

- encrypted with the system keyring through Electron `safeStorage` (GNOME Keyring or KWallet);
- stored in `~/.config/Tokenmeter/secrets.json` with 0600 permissions;
- never sent to the widget's web page;
- only sent to each provider's own API host.

If no keyring is running, Settings shows a warning and the keys are stored unencrypted in that user-only file.

You can also use environment variables instead: `ANTHROPIC_ADMIN_KEY`, `XAI_MANAGEMENT_API_KEY` + `XAI_TEAM_ID`, `OPENAI_ADMIN_KEY`, `GITHUB_TOKEN`. These only apply when you launch the app from a shell.

## Desktop notes

- **Moving it:** drag the header. The window position and size are remembered.
- **Closing it:** × hides the widget to the tray. The tray menu has Show/Hide, Refresh, Always on top, Start at login, Settings and Quit. Launching the app again also brings the widget back.
- **GNOME tray icon:** GNOME needs the *AppIndicator and KStatusNotifierItem Support* extension to show it. Ubuntu ships this by default.
- **Wayland:** native Wayland apps can't keep themselves on top or choose their position. The app therefore runs through XWayland by default ("Use XWayland on Wayland" in Settings).
- **Opening a provider's page:** click a card's name to open its usage page in your browser.
- **Window size:** the widget sizes its height to its content. It shrinks for Compact tiles and grows for Detailed cards or when you add a tool, up to the screen height; past that it scrolls. You set the width, and the grid reflows to it. A widget placed in the lower half of the screen grows upward. Turn this off with "Fit window height to its content" in Settings to size the window by hand.
- **What's left, first:** each card leads with what's left on its tightest limit (Codex shows whichever of the 5-hour and weekly limits is closer). Every tool uses the same green; a bar (and its number) turns red once 80% of the limit is used, i.e. 20% or less is left. Cards without a limit show tokens today.
- **Card size:** Compact / Normal / Detailed, under the header, switch every card between small tiles (two per row, one number, one bar, one footnote), Normal (two per row) and Detailed (the full card, with chart and notes). The grid adds columns as you widen the window. Hover a Compact or Normal card for a moment (or tab to its name) to see its full detail; Esc closes it.
- **Order:** "Nearest limit" (on by default) puts the card closest to running out first. Drag a card, or focus it and press Alt+arrow keys, to set your own order instead; this switches the button to "Custom order". Click it again to go back to sorting by limit.
- **Adding and hiding tools:** hover a card and click × to hide it. The + button in the header lists hidden tools at the top of the widget; click one to bring it back. The button is greyed out when every tool is shown. Settings still has a "Show on widget" checkbox for each tool.

## What the numbers mean (and their limits)

- **Claude Code** counts tokens from your local transcripts, grouped into 5-hour blocks the same way the plan limits work.
  - Anthropic doesn't publish a usage-limit API for Pro/Max plans, so this card shows tokens and time, not a "% of limit".
  - The headline and bar show how much of the current 5-hour window is left.
- **Codex** shows the rate-limit snapshot that the Codex CLI/IDE saves after each turn.
  - It only updates when you use Codex. If a window has reset since your last use, the card shows 100% left and says so.
  - Usage from ChatGPT web (Codex cloud tasks) only appears after a local session records it.
- **Grok CLI** sums the usage each finished turn logs locally. The cost is what the CLI reports (the API-equivalent price), so on a grok.com subscription it isn't what you're billed. Key-based xAI spend is on the xAI API card.
- **GitHub Copilot** uses the same undocumented endpoint as the Copilot editor extensions, so GitHub could change it without notice. Quotas marked unlimited show as a stat instead of a bar.
- **Gemini CLI** counts tokens from chats the CLI saved. Gemini API keys have no usage endpoint, so API usage outside the CLI isn't shown.
- **Claude API** data typically arrives within about 5 minutes. The daily cost buckets are UTC days, and Priority Tier cost isn't included in the cost report.
- **Grok** "month to date" comes from the usage analytics endpoint.
  - The prepaid-credit figure assumes xAI's ledger convention that credits are negative, e.g. a $10 top-up is `-1000` cents.
  - If that figure looks wrong for your account, check it against console.x.ai.

## Layout

```
src/main.js            window, tray, IPC, autostart, polling lifecycle
src/preload.js         minimal API exposed to the page (no Node in the renderer)
src/config.js          config + encrypted secrets
src/poller.js          refresh scheduling; keeps last good numbers when a call fails
src/providers/*.js     one module per source; return a normalized card
src/renderer/*         widget UI (strict CSP, no remote content)
test/                  node:test suite with mocked API responses and fake log folders
```

Adding another provider means adding a module that returns `{ headline, meters, stats, spark, note }` and registering it in `src/providers/index.js`.
