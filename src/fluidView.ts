import * as vscode from 'vscode';
import { UsageTracker } from './usageTracker';
import { readAccount } from './usage-api';

// The model line in the webview is clickable. We can't switch Claude Code's active
// model from here (this is a read-only monitor), so be honest about it.
function onPickModel() {
  vscode.window.showInformationMessage(
    "CC-Fluidity is a read-only monitor — it can't change Claude Code's active model. Use /model inside Claude Code to switch.",
  );
}

// Build the snapshot message and post it to any webview. Shared by the docked
// sidebar view and the pop-out panel/window so both render identically.
export function postSnapshot(webview: vscode.Webview, tracker: UsageTracker) {
  const s = tracker.snapshot();
  const api = s.apiUsage;

  // Local detail for the info panel (current 5-hour block, matching the 5H bar).
  // Pick the PRIMARY model (most tokens this block) and tie tokens/cost to it, so
  // the label and the numbers always agree. `extraModels` = how many other models
  // were also used in the block (shown as "+N").
  const bbm: Record<string, { cost: number; input: number; output: number; cacheCreate: number; cacheRead: number }> =
    (s as any).blockByModel || {};
  const modelNames = Object.keys(bbm);
  const tokensOf = (t: typeof bbm[string]) => t.input + t.output + t.cacheCreate + t.cacheRead;
  let model: string | null = null;
  let best = -1;
  for (const m of modelNames) {
    const tok = tokensOf(bbm[m]);
    if (tok > best) { best = tok; model = m; }
  }
  const primary = model ? bbm[model] : null;

  // Whose account is logged in. Prefer the human name, fall back to the email.
  const acct = readAccount();
  const account = acct ? (acct.displayName || acct.email) : null;

  const detail = {
    model,
    extraModels: Math.max(0, modelNames.length - 1),
    models: modelNames,
    blockTokens: primary ? tokensOf(primary) : 0,
    blockCost: primary ? primary.cost : 0,
    account,
  };

  if (api?.five_hour || api?.seven_day) {
    webview.postMessage({
      type: 'snapshot',
      mode: 'api',
      sessionPct: api.five_hour?.utilization ?? 0,
      weeklyPct: api.seven_day?.utilization ?? 0,
      sessionResetsAt: api.five_hour?.resets_at ?? null,
      weeklyResetsAt: api.seven_day?.resets_at ?? null,
      omelettePct: api.seven_day_omelette?.utilization ?? null,
      omelletteResetsAt: api.seven_day_omelette?.resets_at ?? null,
      ...detail,
    });
  } else {
    const cfg = vscode.workspace.getConfiguration('claudeUsage');
    const dayLimit = cfg.get<number>('dailyBudgetUsd', 5);
    const weekLimit = cfg.get<number>('weeklyBudgetUsd', 50);
    webview.postMessage({
      type: 'snapshot',
      mode: 'local',
      sessionPct: clamp01(s.block.cost / dayLimit) * 100,
      weeklyPct: clamp01(s.week.cost / weekLimit) * 100,
      sessionResetsAt: null,
      weeklyResetsAt: null,
      omelettePct: null,
      omelletteResetsAt: null,
      ...detail,
    });
  }
}

// Resolve the vendored React bundles to webview-safe URIs and the media root
// they live under (needed for localResourceRoots).
function mediaRoot(ctx: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(ctx.extensionUri, 'media');
}
function scriptUris(webview: vscode.Webview, ctx: vscode.ExtensionContext): ScriptUris {
  const uri = (name: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot(ctx), name)).toString();
  return { react: uri('react.js'), reactDom: uri('react-dom.js') };
}

export class FluidView implements vscode.WebviewViewProvider {
  public static readonly viewId = 'claudeUsage.fluid';
  private view?: vscode.WebviewView;

  constructor(private tracker: UsageTracker, private ctx: vscode.ExtensionContext) {
    tracker.on('update', () => this.push());
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot(this.ctx)] };
    view.webview.html = buildHtml(view.webview, scriptUris(view.webview, this.ctx));
    view.webview.onDidReceiveMessage(m => {
      if (m?.type === 'ready') this.push();
      else if (m?.type === 'pickModel') onPickModel();
    });
  }

  private push() {
    if (!this.view) return;
    postSnapshot(this.view.webview, this.tracker);
  }
}

// A pop-out panel that opens in the editor area. The user can split it,
// drag it between editor groups, or "Move into New Window" to float it as a
// freely resizable / repositionable OS window. Singleton: reveals if already open.
export class FluidPanel {
  public static readonly viewType = 'claudeUsage.panel';
  private static current?: FluidPanel;
  private unsubscribe?: () => void;

  static createOrShow(tracker: UsageTracker, ctx: vscode.ExtensionContext) {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active;
    if (FluidPanel.current) {
      FluidPanel.current.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      FluidPanel.viewType,
      'CC-Fluidity',
      column,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot(ctx)] },
    );
    FluidPanel.current = new FluidPanel(panel, tracker, ctx);
  }

  private constructor(
    private panel: vscode.WebviewPanel,
    tracker: UsageTracker,
    ctx: vscode.ExtensionContext,
  ) {
    panel.webview.html = buildHtml(panel.webview, scriptUris(panel.webview, ctx));

    const listener = () => postSnapshot(panel.webview, tracker);
    tracker.on('update', listener);
    this.unsubscribe = () => tracker.off('update', listener);

    panel.webview.onDidReceiveMessage(m => {
      if (m?.type === 'ready') postSnapshot(panel.webview, tracker);
      else if (m?.type === 'pickModel') onPickModel();
    });

    panel.onDidDispose(() => {
      this.unsubscribe?.();
      FluidPanel.current = undefined;
    }, null, ctx.subscriptions);
  }
}

export interface ScriptUris { react: string; reactDom: string; }

export function buildHtml(webview: vscode.Webview, scripts: ScriptUris): string {
    const nonce = nonceFor();
    // React is vendored in media/ and loaded from the webview origin (cspSource) —
    // no CDN dependency and no 'unsafe-eval'. Only our inline app script needs a nonce.
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<style>
  :root {
    /* Solid fill matching whatever container the view is docked in (sidebar /
       secondary sidebar), falling back to the editor bg, then a dark default. */
    --bg:       var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e));
    --stroke:   #9a9a9a;
    /* Theme-adaptive so text stays readable on light themes too. */
    --text:     var(--vscode-foreground, #d8d8d8);
    --text-dim: var(--vscode-descriptionForeground, #9a9a9a);
    --text-sub: var(--vscode-descriptionForeground, #6a6a6a);
    --sans: var(--vscode-font-family, -apple-system, "Segoe UI", system-ui, sans-serif);
    --mono: var(--vscode-editor-font-family, "Cascadia Code", "JetBrains Mono", ui-monospace, Consolas, monospace);
  }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: var(--sans); }
  body { min-height: 100vh; }
  #root { width: 100%; }
  * { box-sizing: border-box; }
  /* Hover-tooltip entry (bouncy rise + overshoot) and exit (quick fade-down). */
  @keyframes tipIn {
    0%   { opacity: 0; transform: translateY(14px) scale(0.90); }
    60%  { opacity: 1; transform: translateY(-4px) scale(1.03); }
    100% { opacity: 1; transform: translateY(0)    scale(1); }
  }
  @keyframes tipOut {
    0%   { opacity: 1; transform: translateY(0)   scale(1); }
    100% { opacity: 0; transform: translateY(8px) scale(0.95); }
  }
</style>
<script nonce="${nonce}" src="${scripts.react}"></script>
<script nonce="${nonce}" src="${scripts.reactDom}"></script>
</head><body>
<div id="root"></div>
<script nonce="${nonce}">
'use strict';
const { useState, useEffect, useRef, useReducer, createElement: h } = React;
const vscode = acquireVsCodeApi();

const FLUID_COUNT = 36;
const LIMIT_WARN = 90;

const PHYSICS = { bodySpring: 62, bodyDamp: 7.8, surfaceSpring: 360, surfaceDamp: 3.0, spread: 24, surfaceKick: 1.6, bodyKick: 2.0 };

function useFluidSurface(target, opts) {
  const { bodySpring, bodyDamp, surfaceSpring, surfaceDamp, spread, surfaceKick, bodyKick } = opts;
  const [, forceUpdate] = useReducer(x => (x + 1) | 0, 0);
  const targetRef = useRef(target);
  targetRef.current = target;
  const sRef = useRef(null);
  if (!sRef.current) {
    sRef.current = { base: 0, baseV: 0, h: new Float32Array(FLUID_COUNT), v: new Float32Array(FLUID_COUNT), lastT: 0, lastTarget: target, didInit: false };
  }
  useEffect(() => {
    const s = sRef.current;
    if (!s.didInit) { s.didInit = true; s.lastTarget = target; return; }
    const diff = target - s.lastTarget;
    if (Math.abs(diff) < 0.001) return;
    s.baseV += diff * bodyKick;
    for (let i = 0; i < FLUID_COUNT; i++) {
      const x = i / (FLUID_COUNT - 1);
      const bias = 0.25 + 0.75 * Math.sin(x * Math.PI);
      s.v[i] -= diff * surfaceKick * bias;
    }
    s.lastTarget = target;
  }, [target, bodyKick, surfaceKick]);
  useEffect(() => {
    let id;
    const tick = (t) => {
      const s = sRef.current;
      const elapsed = s.lastT ? (t - s.lastT) / 1000 : 1 / 60;
      s.lastT = t;
      const steps = 2;
      const dt = Math.min(elapsed, 0.04) / steps;
      const tgt = targetRef.current;
      for (let step = 0; step < steps; step++) {
        s.baseV += (-bodySpring * (s.base - tgt) - bodyDamp * s.baseV) * dt;
        s.base += s.baseV * dt;
        for (let i = 0; i < FLUID_COUNT; i++) {
          s.v[i] += (-surfaceSpring * s.h[i] - surfaceDamp * s.v[i]) * dt;
        }
        for (let pass = 0; pass < 2; pass++) {
          for (let i = 0; i < FLUID_COUNT - 1; i++) {
            const dh = s.h[i] - s.h[i + 1];
            s.v[i] -= spread * dh * dt;
            s.v[i + 1] += spread * dh * dt;
          }
        }
        for (let i = 0; i < FLUID_COUNT; i++) s.h[i] += s.v[i] * dt;
      }
      forceUpdate();
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [bodySpring, bodyDamp, surfaceSpring, surfaceDamp, spread]);
  return sRef.current;
}

function usePhase() {
  const [p, setP] = useState(0);
  useEffect(() => {
    let id;
    const t0 = performance.now();
    const tick = (t) => { setP((t - t0) / 1000); id = requestAnimationFrame(tick); };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);
  return p;
}

const fmtPct = v => Math.round(v) + '%';
const fmtTokens = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n || 0);
const shortModel = m => (m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '') || 'unknown';

function hexToHsl(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substr(0, 2), 16) / 255;
  const g = parseInt(h.substr(2, 2), 16) / 255;
  const b = parseInt(h.substr(4, 2), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let H, S, L = (max + min) / 2;
  if (max === min) { H = 0; S = 0; }
  else {
    const d = max - min;
    S = L > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: H = ((g - b) / d) + (g < b ? 6 : 0); break;
      case g: H = ((b - r) / d) + 2; break;
      default: H = ((r - g) / d) + 4;
    }
    H *= 60;
  }
  return { h: H, s: S, l: L };
}
function lerpHue(a, b, k) { let d = b - a; if (d > 180) d -= 360; if (d < -180) d += 360; return ((a + d * k) % 360 + 360) % 360; }
const RED = { h: 0, s: 0.74, l: 0.50 };
function levelColor(baseHex, pct) {
  const p = Math.max(0, pct);
  const base = hexToHsl(baseHex);
  if (p >= 100) return \`hsl(\${RED.h}, \${(RED.s*100).toFixed(0)}%, \${(RED.l*100).toFixed(0)}%)\`;
  if (p < LIMIT_WARN) {
    const k = p / LIMIT_WARN;
    const lLight = Math.min(0.78, base.l + 0.20);
    const lDark = Math.max(0.18, base.l + 0.02);
    const L = lLight + (lDark - lLight) * k;
    const S = base.s * (0.55 + 0.45 * k);
    return \`hsl(\${base.h.toFixed(1)}, \${(S*100).toFixed(0)}%, \${(L*100).toFixed(0)}%)\`;
  }
  const k = (p - LIMIT_WARN) / (100 - LIMIT_WARN);
  const eK = k * k;
  const lDark = Math.max(0.18, base.l + 0.02);
  const L = lDark + (RED.l - lDark) * eK;
  const S = base.s + (RED.s - base.s) * eK;
  const H = lerpHue(base.h, RED.h, eK);
  return \`hsl(\${H.toFixed(1)}, \${(S*100).toFixed(0)}%, \${(L*100).toFixed(0)}%)\`;
}

// Measure the host element so layout can fit the live webview/window size.
function useSize() {
  const ref = useRef(null);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect;
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

const clampN = (lo, v, hi) => Math.max(lo, Math.min(hi, v));

function Tube({ label, pct, color, planText, w, ht, labelFont, pctFont, planFont, gap, showLabel, showPct, vbW, onHover, onLeave }) {
  const s = useFluidSurface(pct, PHYSICS);
  const phase = usePhase();
  // Internal coordinate space. Height is fixed; width (vbW) is configurable so the
  // capsule can be drawn genuinely fatter (with correct round caps) in mini mode.
  // The SVG is scaled to (w,h) on screen so the tuned fluid physics stay correct.
  const W = vbW || 72, H = 540;
  const stroke = 1.4, pad = 4;
  const innerX = pad, innerY = pad;
  const innerW = W - pad * 2, innerH = H - pad * 2;
  const innerR = innerW / 2;
  const clipId = 'clip-' + label, gradId = 'grad-' + label, glowId = 'glow-' + label;
  const baseLevel = Math.max(-2, Math.min(102, s.base));
  const fluidH = (baseLevel / 100) * innerH;
  const baseY = innerY + innerH - fluidH;
  const fillColor = levelColor(color, baseLevel);
  const pctColor = baseLevel >= LIMIT_WARN ? fillColor : 'var(--text)';
  let energy = 0;
  for (let i = 0; i < FLUID_COUNT; i++) energy += Math.abs(s.h[i]) + Math.abs(s.v[i]) * 0.04;
  const idleFade = Math.max(0, 1 - energy * 0.35);
  const idleAmp = (baseLevel > 1 && baseLevel < 99) ? idleFade * 0.7 : 0;
  const xs = new Array(FLUID_COUNT), ys = new Array(FLUID_COUNT);
  for (let i = 0; i < FLUID_COUNT; i++) {
    const nx = i / (FLUID_COUNT - 1);
    xs[i] = innerX + nx * innerW;
    const idleY = Math.sin(nx * Math.PI * 2.2 + phase * 1.1) * idleAmp + Math.sin(nx * Math.PI * 4.0 - phase * 1.6) * (idleAmp * 0.4);
    ys[i] = baseY + s.h[i] + idleY;
  }
  let d = \`M \${innerX} \${(innerY + innerH).toFixed(2)} L \${innerX.toFixed(2)} \${ys[0].toFixed(2)}\`;
  for (let i = 0; i < FLUID_COUNT - 1; i++) {
    const mx = (xs[i] + xs[i+1]) / 2, my = (ys[i] + ys[i+1]) / 2;
    d += \` Q \${xs[i].toFixed(2)} \${ys[i].toFixed(2)} \${mx.toFixed(2)} \${my.toFixed(2)}\`;
  }
  d += \` T \${xs[FLUID_COUNT-1].toFixed(2)} \${ys[FLUID_COUNT-1].toFixed(2)} L \${(innerX+innerW).toFixed(2)} \${(innerY+innerH).toFixed(2)} Z\`;
  let dRibbon = \`M \${innerX.toFixed(2)} \${ys[0].toFixed(2)}\`;
  for (let i = 0; i < FLUID_COUNT - 1; i++) {
    const mx = (xs[i] + xs[i+1]) / 2, my = (ys[i] + ys[i+1]) / 2;
    dRibbon += \` Q \${xs[i].toFixed(2)} \${ys[i].toFixed(2)} \${mx.toFixed(2)} \${my.toFixed(2)}\`;
  }
  dRibbon += \` T \${xs[FLUID_COUNT-1].toFixed(2)} \${ys[FLUID_COUNT-1].toFixed(2)}\`;

  return h('div', { style: { display:'flex', flexDirection:'column', alignItems:'center', userSelect:'none' } },
    showLabel && h('div', { style: { font:'500 ' + labelFont + 'px/1 var(--sans)', letterSpacing:'0.02em', color:'var(--text)', marginBottom: gap } }, label),
    h('div', {
      onMouseEnter: e => onHover && onHover(e.clientX, e.clientY),
      onMouseMove: e => onHover && onHover(e.clientX, e.clientY),
      onMouseLeave: () => onLeave && onLeave(),
      style: { position:'relative', lineHeight:0 }
    },
      h('svg', { width: w, height: ht, viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio:'xMidYMid meet', style: { display:'block', overflow:'visible' } },
        h('defs', null,
          h('clipPath', { id: clipId }, h('rect', { x: innerX, y: innerY, width: innerW, height: innerH, rx: innerR, ry: innerR })),
          h('linearGradient', { id: gradId, x1:'0', y1:'0', x2:'0', y2:'1' },
            h('stop', { offset:'0',   stopColor: fillColor, stopOpacity:'0.85' }),
            h('stop', { offset:'0.4', stopColor: fillColor, stopOpacity:'1' }),
            h('stop', { offset:'1',   stopColor: fillColor, stopOpacity:'1' })),
          h('radialGradient', { id: glowId, cx:'0.5', cy:'1', r:'0.9' },
            h('stop', { offset:'0', stopColor:'#000', stopOpacity:'0.18' }),
            h('stop', { offset:'1', stopColor:'#000', stopOpacity:'0' }))),
        h('g', { clipPath: 'url(#' + clipId + ')' },
          h('path', { d, fill: 'url(#' + gradId + ')' }),
          baseLevel > 1 && baseLevel < 99 && h('path', { d: dRibbon, fill:'none', stroke:'rgba(255,255,255,0.13)', strokeWidth:'1', strokeLinecap:'round' }),
          h('rect', { x: innerX, y: innerY + innerH - 80, width: innerW, height: 80, fill: 'url(#' + glowId + ')' })),
        h('rect', {
          x: stroke/2 + 0.2, y: stroke/2 + 0.2,
          width: W - stroke - 0.4, height: H - stroke - 0.4,
          rx: (W - stroke - 0.4)/2, ry: (W - stroke - 0.4)/2,
          fill:'none', stroke:'var(--stroke)', strokeWidth: stroke
        })
      )
    ),
    showPct && h('div', { style: { font:'400 ' + pctFont + 'px/1 var(--mono)', color: pctColor, marginTop: gap, letterSpacing:'0.02em', transition:'color 200ms ease' } }, fmtPct(baseLevel)),
    planText && h('div', { style: { font:'400 ' + planFont + 'px/1.3 var(--mono)', color:'var(--text-sub)', marginTop: gap*0.6, letterSpacing:'0.02em' } }, planText)
  );
}

function formatCountdown(isoStr) {
  if (!isoStr) return '';
  const diff = new Date(isoStr).getTime() - Date.now();
  if (diff <= 0) return 'resetting…';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function useCountdown(isoStr, intervalMs) {
  const [text, setText] = useState(() => formatCountdown(isoStr));
  const ref = useRef(isoStr);
  ref.current = isoStr;
  useEffect(() => {
    setText(formatCountdown(ref.current));
    const id = setInterval(() => setText(formatCountdown(ref.current)), intervalMs || 15000);
    return () => clearInterval(id);
  }, [isoStr, intervalMs]);
  return text;
}

function App() {
  const [data, setData] = useState({ mode: 'local', sessionPct: 0, weeklyPct: 0, sessionResetsAt: null, weeklyResetsAt: null, omelettePct: null, omelletteResetsAt: null, model: null, extraModels: 0, models: [], blockTokens: 0, blockCost: 0, account: null });
  useEffect(() => {
    const onMsg = e => { if (e.data?.type === 'snapshot') setData(e.data); };
    window.addEventListener('message', onMsg);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const sessionReset = useCountdown(data.sessionResetsAt, 15000);
  const weeklyReset = useCountdown(data.weeklyResetsAt, 60000);
  const isApi = data.mode === 'api';
  const sourceText = isApi ? 'live · anthropic api' : 'local · ~/.claude/projects';
  const modelLabel = shortModel(data.model) + (data.extraModels > 0 ? ' +' + data.extraModels : '');
  const modelTitle = (data.models && data.models.length ? data.models : [data.model || 'unknown']).join('\\n');

  const [ref, size] = useSize();
  const cw = size.w, ch = size.h;
  const [hover, setHover] = useState(null);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef(null);
  const showHover = info => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    setClosing(false);
    setHover(info);
  };
  const hideHover = () => {
    setClosing(true);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => { setHover(null); setClosing(false); closeTimer.current = null; }, 150);
  };

  // Two compaction tiers driven by the live window size. Compact drops secondary
  // chrome (title, source line, resets) so the tube + label + % keep a legible floor.
  // Three tiers driven by the live window size:
  //  mini    — bars only (no label/%/chrome); hover a tube for its %. Smallest docked form.
  //  compact — labels + tubes + %, but no title/source line.
  //  full    — everything.
  const mini = ch < 190 || cw < 96;
  const compact = mini || ch < 240 || cw < 150;
  // Mini draws somewhat fatter bars (so they read in a tiny panel); larger forms stay slim.
  const RATIO = mini ? 0.19 : 72 / 540;                // tube width / height
  const vbW = Math.round(540 * RATIO);                 // internal viewBox width

  // Horizontal padding scales with width; vertical with height. (Using width for
  // both made a wide+short docked panel waste its scarce height on side padding,
  // shrinking the bars to slivers.)
  const padX = clampN(6, cw * 0.04, 22);
  const padY = mini ? clampN(3, ch * 0.04, 10) : clampN(8, ch * 0.05, 22);
  const labelFont = clampN(11, cw * 0.075, 26);        // 5H / 7D
  const pctFont   = clampN(11, cw * 0.05, 18);         // percentage
  const planFont  = clampN(9,  cw * 0.026, 11);
  const chromeFont = clampN(9, cw * 0.03, 11);
  const gap = compact ? 4 : 10;
  const colGap = mini ? 0 : (compact ? 8 : 16);
  const gapH = clampN(10, cw * 0.06, 40);              // gap between the two tubes
  const hasPlan = !compact && !!(sessionReset || weeklyReset);

  // Reserve vertical space for whatever text is shown; give the rest to the tubes.
  const chromeBlock = compact ? 0 : (chromeFont + 16) * 2;
  const labelBlock = mini ? 0 : labelFont + gap;
  const pctBlock = mini ? 0 : pctFont + gap;
  const planBlock = hasPlan ? planFont + gap * 0.6 : 0;
  const colGapTotal = mini ? 0 : colGap * 2;
  const availH = ch - padY * 2 - chromeBlock - labelBlock - pctBlock - planBlock - colGapTotal;
  const svgMaxH = Math.max(40, availH);

  // Mini fills the height (slim margin); larger forms leave more breathing room.
  const FIT = mini ? 0.94 : 0.86;
  const perTubeW = (cw - padX * 2 - gapH) / 2;
  const tubeW = Math.max(10, Math.min(perTubeW, svgMaxH * RATIO) * FIT);
  const tubeH = tubeW / RATIO;
  // In mini, keep the (now fatter) bars close so they read as a centered pair
  // instead of drifting apart with negative space between them.
  const gapEff = mini ? Math.max(6, tubeW * 0.6) : Math.max(8, Math.min(gapH, tubeW * 1.6));

  const tubeProps = { w: tubeW, ht: tubeH, vbW, labelFont, pctFont, planFont, gap, showLabel: !mini, showPct: !mini };

  const tubes = h('div', { style: { display:'flex', gap: gapEff + 'px', alignItems:'flex-end' } },
    h(Tube, Object.assign({
      label: '5H',
      pct: data.sessionPct,
      color: '#1f7a44',
      planText: hasPlan && sessionReset ? ('resets ' + sessionReset) : null,
      onHover: (mx, my) => showHover({ full: '5-hour window', pct: data.sessionPct, resets: sessionReset, color: '#1f7a44', mx, my }),
      onLeave: () => hideHover()
    }, tubeProps)),
    h(Tube, Object.assign({
      label: '7D',
      pct: data.weeklyPct,
      color: '#7a4a1e',
      planText: hasPlan && weeklyReset ? ('resets ' + weeklyReset) : null,
      onHover: (mx, my) => showHover({ full: '7-day window', pct: data.weeklyPct, resets: weeklyReset, color: '#7a4a1e', mx, my }),
      onLeave: () => hideHover()
    }, tubeProps))
  );

  // Custom hover tooltip — anchored to the cursor, clamped fully inside the
  // viewport (with above/below-cursor flip) so it stays visible even in a tiny
  // panel, and on the top-most layer so nothing overlaps it.
  let tip = null;
  if (hover) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const TIP_W = Math.min(210, vw - 12);
    const TIP_H = 86;
    let tx = Math.max(6, Math.min(vw - TIP_W - 6, hover.mx - TIP_W / 2));
    let ty = hover.my - TIP_H - 14;            // prefer above the cursor
    if (ty < 6) ty = hover.my + 18;            // not enough room → below the cursor
    ty = Math.max(6, Math.min(vh - TIP_H - 6, ty));
    tip = h('div', {
    style: {
      position:'fixed',
      left: tx + 'px',
      top: ty + 'px',
      maxWidth: TIP_W + 'px',
      background: 'var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background, #252526))',
      color: 'var(--vscode-editorHoverWidget-foreground, var(--text))',
      border: '1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, rgba(127,127,127,0.35)))',
      borderRadius: '6px',
      padding: '7px 10px',
      boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
      pointerEvents: 'none',
      zIndex: 2147483647,
      font: '400 11px/1.35 var(--sans)',
      transformOrigin: 'center bottom',
      animation: closing
        ? 'tipOut 140ms ease-in both'
        : 'tipIn 240ms cubic-bezier(0.34, 1.45, 0.5, 1) both'
    }
  },
    h('div', { style: { display:'flex', alignItems:'center', gap:6 } },
      h('span', { style: { width:8, height:8, borderRadius:'50%', background: hover.color, display:'inline-block', flex:'0 0 auto' } }),
      h('span', { style: { color:'var(--text-dim)', letterSpacing:'0.04em' } }, hover.full)
    ),
    h('div', { style: { font:'600 18px/1 var(--mono)', color:'var(--text)', margin:'3px 0' } }, Math.round(hover.pct) + '%'),
    hover.resets && h('div', { style: { color:'var(--text-sub)' } }, 'resets in ' + hover.resets),
    // Model · tokens · cost only in the big view — the mini view already shows it.
    !mini && h('div', { style: { color:'var(--text-sub)', marginTop:5, paddingTop:5, borderTop:'1px solid var(--vscode-widget-border, rgba(127,127,127,0.25))' } },
      modelLabel + ' · ' + fmtTokens(data.blockTokens) + ' tok · ~$' + (data.blockCost || 0).toFixed(2))
    );
  }

  // Mini layout: minimal bars hugging the right, quiet info on the left
  // (active model · tokens · approx cost). The model line is clickable.
  if (mini) {
    const infoFont = clampN(9, tubeH * 0.14, 13);
    // Info + bars are one natural-width cluster, centered. Widening the panel just
    // adds symmetric margin on both sides (width becomes visually neutral); only
    // height scales the bars. This avoids any lopsided dead space.
    return h('div', { ref, style: { width:'100%', height:'100vh', display:'flex', alignItems:'center', justifyContent:'center', gap: Math.max(12, tubeW * 1.4) + 'px', padding: padY + 'px ' + padX + 'px', boxSizing:'border-box', overflow:'hidden' } },
      h('div', { style: { display:'flex', flexDirection:'column', alignItems:'flex-end', textAlign:'right', gap: Math.max(2, tubeH * 0.06) + 'px', minWidth:0 } },
        h('div', {
          title: modelTitle,
          style: { font:'500 ' + infoFont + 'px/1.2 var(--sans)', color:'var(--text-dim)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:'100%' }
        }, modelLabel),
        h('div', { style: { font:'400 ' + infoFont + 'px/1.2 var(--mono)', color:'var(--text-sub)' } }, fmtTokens(data.blockTokens) + ' tok'),
        h('div', { style: { font:'400 ' + infoFont + 'px/1.2 var(--mono)', color:'var(--text-sub)' } }, '~$' + (data.blockCost || 0).toFixed(2))
      ),
      tubes,
      tip
    );
  }

  return h('div', { ref, style: { width:'100%', height:'100vh', display:'flex', alignItems:'center', justifyContent:'center', padding: padY + 'px ' + padX + 'px', boxSizing:'border-box', overflow:'hidden' } },
    h('div', { style: { display:'flex', flexDirection:'column', alignItems:'center', gap: colGap } },
      !compact && h('div', { style: { font:'600 ' + chromeFont + 'px/1 var(--mono)', color:'var(--text-sub)', letterSpacing:'0.22em', textTransform:'uppercase' } }, 'CC-Fluidity'),
      tubes,
      !compact && h('div', { style: { font:'400 ' + chromeFont + 'px/1.4 var(--mono)', color:'var(--text-sub)', letterSpacing:'0.04em', textAlign:'center', maxWidth:260 } }, sourceText),
      !compact && data.account && h('div', { style: { font:'400 ' + chromeFont + 'px/1.4 var(--mono)', color:'var(--text-sub)', letterSpacing:'0.04em', textAlign:'center', maxWidth:260, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' } }, 'account · ' + data.account)
    ),
    tip
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(h(App));
</script>
</body></html>`;
}

function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }

function nonceFor(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
