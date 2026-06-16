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
  // ISO timestamp of the start of the current billing window (the most recent
  // weekly reset). Empty when summarizing by calendar month (legacy fallback).
  period_start: string;
  total_cost_usd: number;
  today_cost_usd: number;
  turns: number;
  // A turn is "cold" when it wrote more cache than it read — i.e. the prompt
  // cache had expired and the whole transcript was re-processed at full price.
  cold_turns: number;
  by_model: Record<string, ModelSummary>;
}

// The weekly reset anchor: a day of the week (0 = Sunday … 6 = Saturday) and a
// local time-of-day. The credit meter counts spend since the most recent
// occurrence of this weekday+time at or before now.
export interface UsageReset {
  weekday: number;
  time: string; // "HH:MM" (24-hour, local)
}

export const DEFAULT_USAGE_RESET: UsageReset = { weekday: 1, time: '00:00' }; // Monday 12:00 AM

// Most recent occurrence of the reset weekday+time at or before `now` (local).
export function computePeriodStart(reset: UsageReset, now: Date = new Date()): Date {
  const [h, m] = (reset.time || '00:00').split(':').map((n) => parseInt(n, 10) || 0);
  const start = new Date(now);
  start.setHours(h, m, 0, 0);
  // Step back to the target weekday (0..6 days). getDay() is unchanged by setHours.
  const daysSince = (start.getDay() - reset.weekday + 7) % 7;
  start.setDate(start.getDate() - daysSince);
  // If that still lands in the future (today is the reset day but its time
  // hasn't passed yet), the current window opened a week earlier.
  if (start.getTime() > now.getTime()) start.setDate(start.getDate() - 7);
  return start;
}

export function getSummary(now: Date = new Date(), periodStart?: Date): UsageSummary {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const today = now.toDateString();
  const startMs = periodStart ? periodStart.getTime() : null;
  const summary: UsageSummary = {
    month,
    period_start: periodStart ? periodStart.toISOString() : '',
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
    if (startMs !== null) {
      if (ts.getTime() < startMs) continue;
    } else {
      const entryMonth = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}`;
      if (entryMonth !== month) continue;
    }

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
