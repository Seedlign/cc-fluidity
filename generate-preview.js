// Renders the REAL webview HTML to a standalone file you can open in a browser.
// It calls the extension's own buildHtml(), stubs acquireVsCodeApi, vendors React
// locally (no CDN), adds an on-screen error overlay, and injects a live snapshot.
const fs = require('fs');
const path = require('path');
const https = require('https');

// fluidView.js does `import * as vscode` at the top. buildHtml() never touches it,
// so hand it an empty stub module to satisfy the require.
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return {};
  return origLoad.call(this, request, parent, isMain);
};

const { buildHtml } = require('./out/fluidView.js');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) { reject(new Error(url + ' -> HTTP ' + res.statusCode)); res.resume(); return; }
      let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c); res.on('end', () => resolve(b));
    }).on('error', reject);
  });
}

// Cache the React UMD bundles locally so the preview is self-contained (works offline).
async function vendor(name, url) {
  const dir = path.join(__dirname, '.preview-vendor');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const src = await fetch(url);
  fs.writeFileSync(file, src, 'utf8');
  return src;
}

(async () => {
  const react = await vendor('react.js', 'https://unpkg.com/react@18.3.1/umd/react.production.min.js');
  const reactDom = await vendor('react-dom.js', 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js');

  // buildHtml(webview, scripts) reads webview.cspSource and the two script URIs.
  // Use placeholder src values, then inline the local bundles in their place.
  let html = buildHtml({ cspSource: "'self'" }, { react: '__REACT__', reactDom: '__REACTDOM__' });

  // Drop the VS Code CSP meta (browser doesn't have the vscode-resource origin).
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');

  // Inline the local bundles. Use function replacers so `$` sequences inside the
  // minified bundles are inserted literally (a replacement *string* would mangle
  // them via $&, $', etc.).
  html = html.replace(/<script[^>]*src="__REACT__"[^>]*><\/script>/, () => '<script>' + react + '</script>');
  html = html.replace(/<script[^>]*src="__REACTDOM__"[^>]*><\/script>/, () => '<script>' + reactDom + '</script>');
  if (html.includes('__REACT__') || html.includes('__REACTDOM__')) throw new Error('a script placeholder was not replaced');

  const now = Date.now();
  const snapshot = {
    type: 'snapshot', mode: 'api', sessionPct: 46, weeklyPct: 9,
    sessionResetsAt: new Date(now + 4 * 3600_000 + 43 * 60_000).toISOString(),
    weeklyResetsAt: new Date(now + 5 * 86_400_000).toISOString(),
    omelettePct: null, omelletteResetsAt: null,
  };

  const inject = `
<script>
  // Surface any runtime error on-screen instead of a blank page.
  window.onerror = function (msg, src, line, col, err) {
    var pre = document.createElement('pre');
    pre.style.cssText = 'color:#ff8080;font:12px monospace;white-space:pre-wrap;padding:16px;position:fixed;top:0;left:0;right:0;z-index:9999;background:#2a1212;margin:0;';
    pre.textContent = 'PREVIEW ERROR: ' + msg + '\\n  at ' + (src||'') + ':' + line + ':' + col + (err && err.stack ? '\\n' + err.stack : '');
    document.body.appendChild(pre);
  };
  window.acquireVsCodeApi = function () { return { postMessage: function () {} }; };
  window.addEventListener('DOMContentLoaded', function () {
    if (typeof React === 'undefined' || typeof ReactDOM === 'undefined') {
      throw new Error('React/ReactDOM not loaded');
    }
    setTimeout(function () {
      window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(snapshot)} }));
    }, 60);
  });
</script>
`;
  html = html.replace('</head>', inject + '</head>');

  // Dark backdrop so the light strokes read (VS Code panel is dark).
  html = html.replace('<body>', '<body style="background:#1e1e1e;">');

  const out = path.join(__dirname, 'preview.html');
  fs.writeFileSync(out, html, 'utf8');
  console.log('wrote', out, '(react vendored locally, error overlay on)');
})().catch(e => { console.error(e); process.exit(1); });
