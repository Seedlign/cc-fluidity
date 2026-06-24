# CC-Fluidity — How It Works

A VS Code extension that renders a fluid-physics test-tube design as a webview. Two tubes — **5H** (5-hour window) and **7D** (7-day window) — fill with sloshing liquid driven by mass-spring-coupled-neighbour physics. It can live as a docked view (sidebar/panel) or be popped out into its own movable, resizable window.

## Tech stack

- **TypeScript + VS Code Extension API** for the host process.
- **`chokidar`** — the one runtime dep. Watches `~/.claude/projects/**/*.jsonl` and reads only the new bytes since the last offset.
- **Webview** registered both as a `WebviewViewProvider` (docked) and a `WebviewPanel` (pop-out window). Inside the webview: **React 18 vendored locally** in `media/` (production UMD builds), running vanilla — the physics code uses `React.createElement`, so there's no build step or transpiler inside the webview.

## Two data sources

The extension blends two independent sources:

1. **Anthropic usage API (preferred → "api" mode).** `src/usage-api.ts` polls `GET https://api.anthropic.com/api/oauth/usage` every 60s, authorized with the OAuth access token read from `~/.claude/.credentials.json`. It returns rate-limit **utilization %** for the `five_hour` and `seven_day` windows — the same numbers as the Claude usage page. Cached in memory (180s TTL) + a temp-file cache, with a 30s fetch cooldown and an expiry guard (skips the call and serves the last good reading if the token is expired, then picks up Claude Code's refreshed token on the next poll). The extension never writes credentials and never refreshes the token itself.

2. **Local JSONL logs (fallback → "local" mode, plus the info readout).** `src/usageTracker.ts` tallies tokens and cost from the transcripts. When the API is unavailable, the tubes fall back to a budget-based cost estimate; the mini info panel always shows the active model, tokens, and approximate cost of the current 5-hour block from this data.

## Data flow

```
chokidar (add/change) ─► UsageTracker.readDelta(file)        usage-api.fetchApiUsage()  (every 60s)
                            ├─ JSON.parse each new line          │  reads ~/.claude/.credentials.json
                            ├─ skip if no message.usage          │  GET /api/oauth/usage (Bearer token)
                            ├─ dedupe by (message.id+requestId)  │  cache (mem 180s + tmp file)
                            ├─ cost = tokens × per-model rate    ▼
                            └─ push UsageEntry            apiUsage stored on tracker
                            ▼                                    │
                        emit('update', snapshot()) ◄─────────────┘
                            ▼
                     postSnapshot(webview, tracker)
                       if apiUsage present → mode:'api'
                         sessionPct = five_hour.utilization
                         weeklyPct  = seven_day.utilization
                       else → mode:'local'
                         sessionPct = block.cost / dailyBudgetUsd  × 100
                         weeklyPct  = week.cost  / weeklyBudgetUsd × 100
                       (+ model, blockTokens, blockCost for the info panel)
                            ▼
                     webview.postMessage({ type:'snapshot', ... })
                            ▼
                     React App setState → responsive layout + Tube re-renders
                            ▼
                     useFluidSurface hook (per tube):
                       • body spring pulls level toward target (with overshoot)
                       • 36-point mass-spring surface with neighbour coupling
                       • level change → splash kick (peaked-in-middle bias)
                       • idle: two-octave sine breathing on the meniscus
                       • level ≥ 90% → hue lerps toward red; ≥100% pure red
```

## Responsive layout

A `ResizeObserver` measures the live webview and drives three tiers:

- **full** — title, `5H`/`7D` labels, tubes, `%`, "resets in…", and the source line.
- **compact** — labels + tubes + `%` (drops title/source).
- **mini** — bars only, hugging a centered cluster, with a quiet right-aligned info readout (active model · tokens · ~cost). Hover a bar for its exact %. This is the smallest docked-beside-the-terminal form.

Tube size is computed to fit both axes; the SVG keeps a fixed internal viewBox (configurable width so mini bars draw fatter) and is scaled to screen, so the tuned physics stay correct. Text colors come from VS Code theme variables, so they stay readable on light themes.

## What's in each tube

- **5H** — `five_hour.utilization` (api) or `block.cost / dailyBudgetUsd` (local). Base color `#1f7a44` (green).
- **7D** — `seven_day.utilization` (api) or `week.cost / weeklyBudgetUsd` (local). Base color `#7a4a1e` (rust).

Both clamp at 100% visually (physics overshoot allowed up to 102%).

## Files

| File | Role |
|---|---|
| `src/extension.ts` | Activate hook — wires tracker → view, registers the `Open as Window` command. |
| `src/usageTracker.ts` | JSONL watcher + aggregator; polls `usage-api`. Exposes `today / week / session / block / all / byModel`. |
| `src/usage-api.ts` | Polls the OAuth usage endpoint; credential read, caching, fetch cooldown, token-expiry guard. |
| `src/pricing.ts` | USD per 1M tokens per model (for local cost estimate + info readout). |
| `src/fluidView.ts` | `buildHtml()` + `postSnapshot()`; `FluidView` (docked) and `FluidPanel` (pop-out window). Inlines the React + physics code with a strict CSP. |
| `src/types.ts` | Shared types. |
| `media/` | Vendored `react.js` / `react-dom.js` (loaded via `asWebviewUri`) + the activity-bar icon. |

## Why a webview (not a status bar item)

The design is a **tall, animated graphic**. The status bar is a single line of text + codicons — no path for SVG animation. A webview gives full rendering control, and the docked view / pop-out panel both stay visible while you work.

## CSP

Strict CSP — nonce-gated inline script, `script-src` limited to the webview origin (`cspSource`) + the nonce, no inline event handlers, no remote origins. React is vendored locally, so there's **no `unpkg` dependency and no `'unsafe-eval'`** (the webview works fully offline).

## Running it

```powershell
cd claude-usage-vscode
npm install
npm run compile
# open this folder in VS Code and press F5
```

In the dev host: click the **beaker icon** in the activity bar — that's the CC-Fluidity view. Use **"CC-Fluidity: Open as Window"** (or the ⧉ button) to pop it out. Fire any Claude Code turn and the levels animate.

## Things that will break it

- The `oauth/usage` endpoint is **undocumented/unsupported** — if Anthropic changes or removes it, the extension drops to local mode.
- Anthropic changes the JSONL schema → `ingest()` needs adjusting.
- New model names not in `pricing.ts` → local cost falls back to Sonnet rates.
