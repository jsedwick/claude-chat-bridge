import fs from 'fs';
import path from 'path';
import { config } from '../config';

// Append-only per-turn cost ledger (JSONL), next to the session store. Lives
// outside chat-sessions.json so spend stays counted even after a conversation
// is trashed or deleted — the monthly budget meter must never undercount.
const ledgerPath = path.join(path.dirname(config.sessionStorePath), 'usage-ledger.jsonl');

export interface LedgerEntry {
  ts: string;
  session_id: string;
  model?: string;
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  duration_ms?: number;
}

export function recordTurn(entry: LedgerEntry): void {
  try {
    fs.appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[usage-ledger] append failed:', err);
  }
}

interface ModelSummary {
  cost_usd: number;
  turns: number;
}

export interface UsageSummary {
  month: string;
  total_cost_usd: number;
  today_cost_usd: number;
  turns: number;
  // A turn is "cold" when it wrote more cache than it read — i.e. the prompt
  // cache had expired and the whole transcript was re-processed at full price.
  cold_turns: number;
  by_model: Record<string, ModelSummary>;
}

export function getSummary(now: Date = new Date()): UsageSummary {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const today = now.toDateString();
  const summary: UsageSummary = {
    month,
    total_cost_usd: 0,
    today_cost_usd: 0,
    turns: 0,
    cold_turns: 0,
    by_model: {},
  };

  let raw: string;
  try {
    raw = fs.readFileSync(ledgerPath, 'utf-8');
  } catch {
    return summary;
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: LedgerEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = new Date(entry.ts);
    if (isNaN(ts.getTime())) continue;
    const entryMonth = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}`;
    if (entryMonth !== month) continue;

    const cost = entry.cost_usd || 0;
    summary.total_cost_usd += cost;
    summary.turns += 1;
    if (ts.toDateString() === today) summary.today_cost_usd += cost;
    if ((entry.cache_creation_input_tokens || 0) > (entry.cache_read_input_tokens || 0)) {
      summary.cold_turns += 1;
    }

    const model = entry.model || 'unknown';
    const m = summary.by_model[model] || (summary.by_model[model] = { cost_usd: 0, turns: 0 });
    m.cost_usd += cost;
    m.turns += 1;
  }

  return summary;
}
