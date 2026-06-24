import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import chokidar from 'chokidar';
import { TranscriptLine, UsageEntry, Totals } from './types';
import { costFor } from './pricing';
import { fetchApiUsage, ApiUsageData } from './usage-api';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const API_POLL_MS = 60_000;

export class UsageTracker extends EventEmitter {
  private offsets = new Map<string, number>();
  private seen = new Set<string>();           // dedupe key: messageId:requestId
  private entries: UsageEntry[] = [];
  private watcher?: chokidar.FSWatcher;
  private apiTimer?: ReturnType<typeof setInterval>;
  private apiUsage: ApiUsageData | null = null;

  constructor(private projectsDir: string) { super(); }

  static defaultDir(): string {
    return path.join(os.homedir(), '.claude', 'projects');
  }

  start() {
    if (!fs.existsSync(this.projectsDir)) {
      this.emit('warn', `Not found: ${this.projectsDir}`);
      return;
    }
    const glob = path.join(this.projectsDir, '**', '*.jsonl').replace(/\\/g, '/');
    console.log('[ClaudeUsage] watching:', glob);
    this.watcher = chokidar.watch(glob, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });
    this.watcher.on('add', f => { console.log('[ClaudeUsage] add:', f); this.readDelta(f); });
    this.watcher.on('change', f => { console.log('[ClaudeUsage] change:', f); this.readDelta(f); });
    this.watcher.on('error', e => { console.error('[ClaudeUsage] watcher error:', e); this.emit('warn', String(e)); });

    this.pollApi();
    this.apiTimer = setInterval(() => this.pollApi(), API_POLL_MS);
  }

  stop() {
    this.watcher?.close();
    if (this.apiTimer) clearInterval(this.apiTimer);
  }

  private async pollApi() {
    try {
      const data = await fetchApiUsage();
      if (data && data !== this.apiUsage) {
        this.apiUsage = data;
        this.emit('update', this.snapshot());
      }
    } catch (err) {
      console.error('[ClaudeUsage] API poll error:', err);
    }
  }

  private readDelta(file: string) {
    try {
      const stat = fs.statSync(file);
      const from = this.offsets.get(file) ?? 0;
      if (stat.size <= from) { this.offsets.set(file, stat.size); return; }
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(stat.size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
      this.offsets.set(file, stat.size);

      const text = buf.toString('utf8');
      let added = 0;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        if (this.ingest(line)) added++;
      }
      if (added) this.emit('update', this.snapshot());
    } catch (e) {
      this.emit('warn', `read ${file}: ${(e as Error).message}`);
    }
  }

  private ingest(line: string): boolean {
    let obj: TranscriptLine;
    try { obj = JSON.parse(line); } catch { return false; }
    const usage = obj.message?.usage;
    if (!usage) return false;
    const key = `${obj.message?.id ?? ''}:${obj.requestId ?? ''}`;
    if (key !== ':' && this.seen.has(key)) return false;
    this.seen.add(key);

    const model = obj.message?.model ?? 'unknown';
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : Date.now();
    this.entries.push({
      ts,
      sessionId: obj.sessionId ?? 'unknown',
      model,
      tokens: usage,
      cost: costFor(model, usage),
      cwd: obj.cwd,
    });
    return true;
  }

  snapshot() {
    return {
      today: this.totalsSince(startOfToday()),
      week: this.totalsSince(startOfWeek()),
      session: this.totalsForLatestSession(),
      block: this.totalsForCurrentBlock(),
      all: this.totals(this.entries),
      byModel: this.byModel(),
      blockByModel: this.byModelForCurrentBlock(),
      recent: this.entries.slice(-50).reverse(),
      apiUsage: this.apiUsage,
    };
  }

  private totals(rows: UsageEntry[]): Totals {
    const t: Totals = { cost: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, entries: rows.length };
    for (const r of rows) {
      t.cost += r.cost;
      t.input += r.tokens.input_tokens || 0;
      t.output += r.tokens.output_tokens || 0;
      t.cacheCreate += r.tokens.cache_creation_input_tokens || 0;
      t.cacheRead += r.tokens.cache_read_input_tokens || 0;
    }
    return t;
  }

  private totalsSince(ms: number) { return this.totals(this.entries.filter(e => e.ts >= ms)); }

  private totalsForLatestSession() {
    const last = this.entries[this.entries.length - 1];
    if (!last) return this.totals([]);
    return this.totals(this.entries.filter(e => e.sessionId === last.sessionId));
  }

  private totalsForCurrentBlock() {
    const last = this.entries[this.entries.length - 1];
    if (!last) return this.totals([]);
    const blockStart = last.ts - FIVE_HOURS_MS;
    return this.totals(this.entries.filter(e => e.ts >= blockStart));
  }

  private byModel() {
    return this.byModelFor(this.entries);
  }

  // Per-model totals restricted to the current 5-hour block (aligns with the 5H bar).
  private byModelForCurrentBlock() {
    const last = this.entries[this.entries.length - 1];
    if (!last) return {};
    const blockStart = last.ts - FIVE_HOURS_MS;
    return this.byModelFor(this.entries.filter(e => e.ts >= blockStart));
  }

  private byModelFor(rows: UsageEntry[]) {
    const map = new Map<string, Totals>();
    for (const e of rows) {
      const t = map.get(e.model) ?? { cost: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, entries: 0 };
      t.cost += e.cost;
      t.input += e.tokens.input_tokens || 0;
      t.output += e.tokens.output_tokens || 0;
      t.cacheCreate += e.tokens.cache_creation_input_tokens || 0;
      t.cacheRead += e.tokens.cache_read_input_tokens || 0;
      t.entries++;
      map.set(e.model, t);
    }
    return Object.fromEntries(map);
  }
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeek(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  // Monday-start week. getDay(): 0=Sun..6=Sat → shift so Mon=0.
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d.getTime();
}
