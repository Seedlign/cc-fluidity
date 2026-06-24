// Live monitor — mirrors the extension's data path. Read-only.
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function readCreds() {
  const raw = fs.readFileSync(path.join(configDir(), '.credentials.json'), 'utf8');
  const o = JSON.parse(raw)?.claudeAiOauth;
  if (!o?.accessToken) return null;
  return { accessToken: o.accessToken, expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : null };
}

function get(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 10000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Tally tokens written to local JSONL within the current rolling 5h block.
function localBlockTokens() {
  const dir = path.join(configDir(), 'projects');
  const cutoff = Date.now() - 5 * 60 * 60 * 1000;
  let input = 0, output = 0, cacheCreate = 0, cacheRead = 0, entries = 0;
  const seen = new Set();
  function walk(d) {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else if (it.name.endsWith('.jsonl')) {
        let text = '';
        try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          let obj; try { obj = JSON.parse(line); } catch { continue; }
          const u = obj?.message?.usage;
          if (!u) continue;
          const key = `${obj?.message?.id ?? ''}:${obj?.requestId ?? ''}`;
          if (key !== ':' && seen.has(key)) continue;
          seen.add(key);
          const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
          if (ts < cutoff) continue;
          input += u.input_tokens || 0;
          output += u.output_tokens || 0;
          cacheCreate += u.cache_creation_input_tokens || 0;
          cacheRead += u.cache_read_input_tokens || 0;
          entries++;
        }
      }
    }
  }
  walk(dir);
  return { input, output, cacheCreate, cacheRead, entries };
}

async function tick(n) {
  const stamp = new Date().toLocaleTimeString();
  const creds = readCreds();
  if (!creds) { console.log(`[${stamp}] no creds`); return; }
  const expIn = creds.expiresAt ? Math.round((creds.expiresAt - Date.now()) / 1000) : null;

  let api = '(skipped: token expired)';
  if (!(creds.expiresAt && Date.now() >= creds.expiresAt - 60000)) {
    try {
      const r = await get('https://api.anthropic.com/api/oauth/usage', {
        Authorization: `Bearer ${creds.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      });
      if (r.status !== 200) { api = `HTTP ${r.status}`; }
      else {
        const d = JSON.parse(r.body);
        const f = d.five_hour, w = d.seven_day;
        api = `5h=${f ? f.utilization + '%' : '—'} (resets ${f ? new Date(f.resets_at).toLocaleTimeString() : '—'})  7d=${w ? w.utilization + '%' : '—'}`;
      }
    } catch (e) { api = `ERR ${e.message}`; }
  }

  const lt = localBlockTokens();
  const total = lt.input + lt.output + lt.cacheCreate + lt.cacheRead;
  console.log(
    `[${stamp}] #${n}  API: ${api}\n` +
    `            local 5h-block: ${total.toLocaleString()} tok ` +
    `(in ${lt.input.toLocaleString()} / out ${lt.output.toLocaleString()} / cw ${lt.cacheCreate.toLocaleString()} / cr ${lt.cacheRead.toLocaleString()}, ${lt.entries} msgs)` +
    (expIn !== null ? `   [token expires in ${Math.round(expIn / 60)}m]` : '')
  );
}

let n = 0;
const MAX = parseInt(process.argv[2] || '8', 10);
const EVERY = parseInt(process.argv[3] || '30', 10) * 1000;
(async () => {
  await tick(++n);
  const t = setInterval(async () => {
    await tick(++n);
    if (n >= MAX) { clearInterval(t); console.log('--- monitor done ---'); }
  }, EVERY);
})();
