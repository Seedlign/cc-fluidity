# CC-Fluidity (VS Code)

## Main feature

CC-Fluidity is a small, read-only VS Code view that shows your **Claude Code** usage as two fluid-physics test tubes — your **5-hour (5H)** and **7-day (7D)** rate-limit windows. It reads your local Claude Code data and Anthropic's usage endpoint to display real utilization in real time. A hobby/portfolio project: no telemetry, no accounts, nothing monetary.

## Functionalities

- **Two live gauges** — the 5H and 7D tubes fill to your current rate-limit utilization and update as you use Claude Code.
- **Two data modes:**
  - **api** (preferred) — reads real **utilization %** from Anthropic's usage endpoint (the same numbers as the Claude usage page).
  - **local** (fallback) — when the API is unreachable, estimates from your local Claude Code logs against a configurable budget.
- **Responsive layout** — full / compact / a smallest "bars-only" form for docking beside the terminal.
- **Detail on demand** — hover a tube for its exact %, reset countdown, and (in the big view) the active model, tokens, and approximate cost for the current block. With multiple models in use, it shows the primary model plus a `+N` count.
- **Dockable or floating** — live in the sidebar/panel, or pop it out into its own movable, resizable window ("CC-Fluidity: Open as Window").

## Data access & privacy

Read this before installing — the extension touches local Claude Code files and calls an undocumented endpoint.

**It reads, locally on your machine:**
- `~/.claude/.credentials.json` — to obtain your existing Claude Code OAuth **access token**, used only to authorize the usage request below. The extension **never** writes this file, never refreshes/rotates the token (Claude Code owns that), and never transmits it anywhere except to Anthropic's own API.
- `~/.claude/projects/**/*.jsonl` — your local Claude Code transcripts, read-only, to tally tokens/cost.

**It makes one network call:** `GET https://api.anthropic.com/api/oauth/usage`, authorized with your token. This is an **internal, undocumented, unsupported** endpoint used by Claude Code itself and **may change or break without notice**; if it does, the extension falls back to local mode.

### When you get *real* numbers vs. estimates

The preferred **api** mode (real rate-limit utilization %) only works when an OAuth access token is present in `~/.claude/.credentials.json`. That means:

- **Windows / Linux, logged into Claude Code with a Claude.ai (Pro/Max) account** — works automatically, zero config.
- **macOS** — Claude Code stores its OAuth token in the **macOS Keychain**, *not* in `.credentials.json`, so the extension can't read it. It silently falls back to **local** mode (estimates against the budgets below).
- **API-key / Console billing** (no Claude.ai OAuth login) — no token to read, so **local** mode only.

In the fallback cases nothing errors — the tubes just show rough local estimates rather than your true rate-limit percentages.

**It does not** send your data to third parties, run analytics/telemetry, open any other network connection, or modify your Claude Code configuration or login. If you're not comfortable with this, don't install it.

## Tech stack & dependencies

- **TypeScript**, compiled with `tsc` (no bundler).
- **VS Code Extension API** (`engines.vscode ^1.85.0`); webview view + webview panel.
- **`chokidar`** — the only runtime dependency; watches `~/.claude/projects` for new transcript bytes.
- **React 18** (UMD production builds) **vendored locally** in `media/` and loaded via `asWebviewUri` — no CDN, no `unsafe-eval`, works offline.

## Installation

### Option A — install the prebuilt `.vsix` (recommended)

1. Download `cc-fluidity-<version>.vsix` from the [latest release](https://github.com/Seedlign/cc-fluidity/releases/latest).
2. Install it:
   ```powershell
   code --install-extension cc-fluidity-0.0.1.vsix
   ```
   …or in VS Code: **Extensions** panel → **⋯** menu → **Install from VSIX…** → pick the file.
3. Reload, then click the **beaker** icon in the activity bar.

The `.vsix` is self-contained (the runtime dependency is bundled), so no `npm install` is needed.

### Option B — run from source (for development)

```powershell
git clone https://github.com/Seedlign/cc-fluidity.git
cd cc-fluidity
npm install
npm run compile
# open the folder in VS Code and press F5
```

In the dev-host window, click the **beaker** icon in the activity bar. The tubes appear and update as you use Claude Code. Use **"CC-Fluidity: Open as Window"** (or the ⧉ button in the view header) to pop it out.

> Note: a `git clone` alone does **not** install the extension into your editor — use Option A's `.vsix` for a real install, or press F5 in Option B for a temporary Extension Development Host window.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `claudeUsage.projectsDir` | _autodetect_ | Override path to `~/.claude/projects`. |
| `claudeUsage.dailyBudgetUsd` | `5` | Local-mode only: cost that 100% of the 5H tube represents when the API is unavailable. |
| `claudeUsage.weeklyBudgetUsd` | `50` | Local-mode only: cost that 100% of the 7D tube represents when the API is unavailable. |

## Disclaimer

Not affiliated with or endorsed by Anthropic. "Claude" is a trademark of Anthropic. This project relies on undocumented behavior that may stop working at any time.
