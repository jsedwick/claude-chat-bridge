import { Router } from 'express';
import {
  getSummary,
  computePeriodStart,
  DEFAULT_USAGE_RESET,
  UsageReset,
} from '../services/usage-ledger';
import { loadBridgeConfig, setBridgeConfigValue } from '../config';

const router = Router();

// The persisted weekly reset anchor, falling back to the default (Monday 12 AM).
function getReset(): UsageReset {
  const r = loadBridgeConfig().usageReset;
  if (
    r && typeof r.weekday === 'number' && r.weekday >= 0 && r.weekday <= 6 &&
    typeof r.time === 'string'
  ) {
    return { weekday: r.weekday, time: r.time };
  }
  return DEFAULT_USAGE_RESET;
}

// Metered spend since the current weekly reset, aggregated from the per-turn
// ledger. Includes the active reset anchor so the UI can label the window.
router.get('/summary', (_req, res) => {
  const reset = getReset();
  const summary = getSummary(new Date(), computePeriodStart(reset));
  res.json({ ...summary, reset });
});

router.get('/reset', (_req, res) => {
  res.json(getReset());
});

// Update the weekly reset anchor (persists to bridge-config.json).
router.put('/reset', (req, res) => {
  const { weekday, time } = req.body || {};
  if (
    typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6 ||
    typeof time !== 'string' || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)
  ) {
    return res.status(400).json({ error: 'weekday must be an integer 0-6 and time must be "HH:MM"' });
  }
  const reset: UsageReset = { weekday, time };
  setBridgeConfigValue('usageReset', reset);
  res.json(reset);
});

export default router;
