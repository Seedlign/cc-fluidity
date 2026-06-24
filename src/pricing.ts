import { Usage } from './types';

// USD per 1M tokens. Update as Anthropic publishes new rates.
const RATES: Record<string, { in: number; out: number; cacheWrite: number; cacheRead: number }> = {
  'claude-opus-4':       { in: 15,   out: 75,  cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4':     { in: 3,    out: 15,  cacheWrite: 3.75,  cacheRead: 0.3 },
  'claude-haiku-4':      { in: 1,    out: 5,   cacheWrite: 1.25,  cacheRead: 0.1 },
  'claude-3-5-sonnet':   { in: 3,    out: 15,  cacheWrite: 3.75,  cacheRead: 0.3 },
  'claude-3-5-haiku':    { in: 0.8,  out: 4,   cacheWrite: 1.0,   cacheRead: 0.08 },
};

function resolve(model: string) {
  const m = model.toLowerCase();
  for (const key of Object.keys(RATES)) {
    if (m.includes(key)) return RATES[key];
  }
  return RATES['claude-sonnet-4'];
}

export function costFor(model: string, u: Usage): number {
  const r = resolve(model);
  const M = 1_000_000;
  return (
    (u.input_tokens || 0) * r.in / M +
    (u.output_tokens || 0) * r.out / M +
    (u.cache_creation_input_tokens || 0) * r.cacheWrite / M +
    (u.cache_read_input_tokens || 0) * r.cacheRead / M
  );
}
