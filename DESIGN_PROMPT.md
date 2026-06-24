# Design Prompt — CC-Fluidity VSCode Extension

Paste the block below into Claude (or Figma AI / v0 / any design-capable model) to generate high-fidelity mockups for the three UI surfaces.

---

## PROMPT

You are designing UI for a VSCode extension called **CC-Fluidity**. It shows real-time token and cost consumption from Claude Code sessions. The audience is a single developer using it for personal observability — playful but information-dense, not enterprise dashboard energy.

Produce high-fidelity mockups (PNG or Figma frames) for three surfaces. Use the VSCode dark theme as the base (`#1e1e1e` background, `#cccccc` text, `#0e639c` accent), but feel free to introduce one secondary accent color that suggests "Claude" — a warm rust/amber works well against the cool editor blues. Use the editor's system font stack (`-apple-system, Segoe UI, sans-serif`) and a monospace for numbers (`Cascadia Code, Consolas`).

### Surface 1 — Status bar item

A single segment that sits in VSCode's bottom-right status bar.

- Compact form (default): a sparkle/spark icon + `$0.1234` + the model name truncated. Max ~24 chars.
- Hover tooltip: a small floating card showing Today / Current session / 5h block as a tiny three-row table with cost + token count.
- States to mock: idle (no data yet), normal, near-limit (block cost above a threshold — subtle amber tint), error (red dot).

### Surface 2 — Explorer tree view

A panel inside VSCode's Explorer sidebar titled "CLAUDE USAGE". Tree rows, each ~22px tall.

- Top-level rows: `Today`, `Current session`, `5h block`, `All time`. Each shows cost prominently and a muted secondary line with token count + turn count.
- Each row expands to children: `Input`, `Output`, `Cache read`, `Cache write`, each with their token count and a tiny inline bar showing proportion.
- The whole thing must feel like a native tree view — no boxes, no card chrome, just rows with iconography. Use codicon-style icons (outline, monochrome, 16px).

### Surface 3 — Webview dashboard

A full editor-tab dashboard. Layout (top to bottom):

1. **Header strip**: title "CC-Fluidity" left, "last update 2s ago · live" indicator right with a pulsing dot.
2. **KPI cards row**: four equal cards — Today, Current session, 5h block, All time. Each card: tiny uppercase label, huge cost number (monospace), secondary line with token count and turn count, and a sparkline of the last 24h trend along the bottom edge of the card.
3. **By-model breakdown**: a horizontal stacked bar (one bar, full width) showing the cost share per model with a legend. Below it, a compact table: Model · Cost · Input · Output · Cache read · Turns.
4. **Recent turns**: a 50-row scrollable list. Each row is a single line: timestamp · model badge · tokens in→out · cost. Hover reveals the cwd and sessionId in a popover.
5. **5-hour block gauge**: an arc/radial gauge in the bottom-right corner showing time elapsed in the current rate-limit window and cost burned, with a projected end-of-window cost.

### General notes

- Numbers should always be right-aligned and monospace.
- Cost values use 4 decimals when small (`$0.0034`), 2 decimals when large (`$12.45`).
- Empty states matter — design the "no Claude Code activity detected yet" state for the dashboard as a friendly illustration + a one-liner explaining where the extension is looking (`~/.claude/projects`).
- This is a hobby project for one developer's use, so allow personality: a small mascot, an Easter-egg micro-interaction on the sparkline, etc. Don't go overboard.

### Deliverables

- One frame per surface above (so 3 frames minimum).
- Plus 2 state variants for the status bar (normal, near-limit) and 1 empty-state for the dashboard.
- Light theme variant of the dashboard, optional.

Output the Figma frames or rendered PNGs. If you can only produce one image, prioritize the dashboard (Surface 3).

---

## Tips for iterating

After the first render, ask for:
- "Tighten the KPI cards — less padding, smaller secondary text."
- "Show me the near-limit status bar state with a real number."
- "The recent turns list looks too much like a log file — make it feel like a feed."
- "Try a warmer secondary accent — current one fights with the VSCode blue."
