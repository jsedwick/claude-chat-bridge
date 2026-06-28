// Regression test for the per-session context-window meter behavior.
//
// Spec (user request): the bar shows by DEFAULT once a session has context,
// carries an × to dismiss it, and RE-APPEARS when context climbs past 50% and
// again past 75% — even after a dismiss. Dismiss state is per-session/in-memory.
//
// The meter logic lives in public/app.js — a browser script with no module
// exports and no DOM test harness in this project. So we (a) extract and exercise
// the REAL ctxMeterTier() threshold fn straight from source (threshold changes
// are caught here), and (b) drive the show/dismiss state machine through the
// exact visibility gate used in refreshContextMeter() — see the
// "dismissed != null && tier <= dismissed" line there — to lock the behavior.
//
// Reads public/app.js directly, so no `npm run build` is required.
// Run: node --test test/ctx-meter.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', 'public', 'app.js'), 'utf8');

// Pull the real ctxMeterTier() out of app.js so a threshold edit fails this test.
const match = appSrc.match(/function ctxMeterTier\(pct\)\s*\{[\s\S]*?\n\}/);
assert.ok(match, 'ctxMeterTier(pct) not found in public/app.js — renamed or moved?');
const ctxMeterTier = new Function(`${match[0]}; return ctxMeterTier;`)();

// Mirrors the visibility gate in refreshContextMeter(): show UNLESS the current
// tier is at or below the tier last dismissed. null === never dismissed this session.
const shouldShow = (pct, dismissedTier) => {
  const tier = ctxMeterTier(pct);
  return !(dismissedTier != null && tier <= dismissedTier);
};

test('ctxMeterTier thresholds (0=<50%, 1=50-74%, 2=>=75%)', () => {
  assert.equal(ctxMeterTier(0), 0);
  assert.equal(ctxMeterTier(0.49), 0);
  assert.equal(ctxMeterTier(0.50), 1);
  assert.equal(ctxMeterTier(0.74), 1);
  assert.equal(ctxMeterTier(0.75), 2);
  assert.equal(ctxMeterTier(0.90), 2);
  assert.equal(ctxMeterTier(1.2), 2); // cache_read can push the ratio >100%
});

test('shows by default (no dismiss) at every tier', () => {
  assert.equal(shouldShow(0.10, null), true);
  assert.equal(shouldShow(0.55, null), true);
  assert.equal(shouldShow(0.80, null), true);
});

test('dismiss hides only within the current tier', () => {
  assert.equal(shouldShow(0.10, 0), false);
  assert.equal(shouldShow(0.49, 0), false);
});

test('re-appears crossing 50%, then again crossing 75%', () => {
  assert.equal(shouldShow(0.50, 0), true); // dismissed <50%, climb into 50-74%
  assert.equal(shouldShow(0.75, 1), true); // dismissed 50-74%, climb into >=75%
});

test('dismiss at >=75% stays hidden (no higher tier)', () => {
  assert.equal(shouldShow(0.75, 2), false);
  assert.equal(shouldShow(0.95, 2), false);
});

test('full spec scenario: default -> ×@10% -> 50% -> ×@55% -> 75% -> ×@80%', () => {
  let dismissed = null;
  assert.equal(shouldShow(0.10, dismissed), true, 'visible by default');
  dismissed = ctxMeterTier(0.10);                  // user clicks ×
  assert.equal(shouldShow(0.10, dismissed), false, 'hidden after dismiss');
  assert.equal(shouldShow(0.50, dismissed), true, 're-appears crossing 50%');
  dismissed = ctxMeterTier(0.55);                  // user clicks × again
  assert.equal(shouldShow(0.60, dismissed), false, 'hidden again in 50-74% band');
  assert.equal(shouldShow(0.75, dismissed), true, 're-appears crossing 75%');
  dismissed = ctxMeterTier(0.80);                  // user clicks × at 75%+
  assert.equal(shouldShow(0.99, dismissed), false, 'stays hidden past final tier');
});
