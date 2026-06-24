import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ApiLimitWindow {
  utilization: number;
  resets_at: string;
}

export interface ApiExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
  currency: string | null;
  disabled_reason: string | null;
}

export interface ApiUsageData {
  five_hour: ApiLimitWindow | null;
  seven_day: ApiLimitWindow | null;
  seven_day_opus: ApiLimitWindow | null;
  seven_day_sonnet: ApiLimitWindow | null;
  seven_day_omelette: ApiLimitWindow | null;
  seven_day_cowork: ApiLimitWindow | null;
  seven_day_oauth_apps: ApiLimitWindow | null;
  extra_usage: ApiExtraUsage | null;
  fetchedAt: number;
}

const CACHE_TTL_MS = 180_000;
const LOCK_COOLDOWN_MS = 30_000;

let memCache: ApiUsageData | null = null;
let lastFetchAttempt = 0;

function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function getCacheFilePath(): string {
  return path.join(os.tmpdir(), 'claude-usage-cache.json');
}

function readCredentials(): { accessToken: string; expiresAt: number | null } | null {
  try {
    const credPath = path.join(getClaudeConfigDir(), '.credentials.json');
    const raw = fs.readFileSync(credPath, 'utf8');
    const parsed = JSON.parse(raw);
    const oauth = parsed?.claudeAiOauth;
    const token = oauth?.accessToken;
    if (!token) return null;
    // expiresAt is epoch ms. We do NOT refresh the token ourselves — Claude Code
    // owns that and rotates the refresh token; writing it back incorrectly would
    // corrupt the user's login. We just re-read this file every poll and pick up
    // whatever token Claude Code last wrote.
    return { accessToken: token, expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null };
  } catch {
    return null;
  }
}

function readFileCache(): ApiUsageData | null {
  try {
    const raw = fs.readFileSync(getCacheFilePath(), 'utf8');
    return JSON.parse(raw) as ApiUsageData;
  } catch {
    return null;
  }
}

function writeFileCache(data: ApiUsageData): void {
  try {
    fs.writeFileSync(getCacheFilePath(), JSON.stringify(data), 'utf8');
  } catch { /* best-effort */ }
}

function httpGet(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 10_000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

export async function fetchApiUsage(): Promise<ApiUsageData | null> {
  if (memCache && Date.now() - memCache.fetchedAt < CACHE_TTL_MS) {
    return memCache;
  }

  const now = Date.now();
  const stale = memCache || readFileCache();

  if (now - lastFetchAttempt < LOCK_COOLDOWN_MS) {
    return stale;
  }

  const creds = readCredentials();
  if (!creds) return stale;

  // Token expired (60s skew)? The request would just 401. Skip it and serve the
  // last good reading; the next poll re-reads the file and will pick up the
  // refreshed token once the user next uses Claude Code.
  if (creds.expiresAt !== null && now >= creds.expiresAt - 60_000) {
    return stale;
  }

  lastFetchAttempt = now;

  try {
    const body = await httpGet('https://api.anthropic.com/api/oauth/usage', {
      'Authorization': `Bearer ${creds.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
    });
    const raw = JSON.parse(body);
    const data: ApiUsageData = { ...raw, fetchedAt: Date.now() };
    memCache = data;
    writeFileCache(data);
    return data;
  } catch (err) {
    console.error('[ClaudeUsage] API fetch failed:', err);
    return stale;
  }
}
