export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface TranscriptLine {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  requestId?: string;
  cwd?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: Usage;
  };
}

export interface UsageEntry {
  ts: number;
  sessionId: string;
  model: string;
  tokens: Usage;
  cost: number;
  cwd?: string;
}

export interface Totals {
  cost: number;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  entries: number;
}
