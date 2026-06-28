// Regression test for the AskUserQuestion "card never renders / chat hangs" bug.
//
// Root cause (confirmed from bridge logs): in `claude -p` mode the AUQ input is
// frequently NOT streamed as input_json_delta events, so content_block_stop
// synthesized a tool_use with empty input AND armed post-AUQ suppression — which
// then dropped the authoritative assistant snapshot that DID carry the
// questions. Result: a "Question" entry in Tools-used, no card, silent hang.
//
// Fix: never emit a synthesized AUQ (and never arm suppression) unless the input
// actually carries questions; otherwise defer to the assistant snapshot.
//
// Run: node --test test/auq-render.test.mjs   (requires `npm run build` first)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as runner from '../dist/services/claude-runner.js';

const { parseClaudeEvent, askUserHasQuestions } = runner;

const startEvt = (index, id) => ({
  type: 'stream_event',
  event: { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'AskUserQuestion' } },
});
const deltaEvt = (index, partial_json) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } },
});
const stopEvt = (index) => ({ type: 'stream_event', event: { type: 'content_block_stop', index } });
const snapshotEvt = (id, input) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input }] },
});

const QUESTIONS = [{ question: 'Deploy now?', header: 'Deploy', options: [{ label: 'Yes' }, { label: 'No' }] }];

const asArray = (r) => (r == null ? [] : Array.isArray(r) ? r : [r]);
const toolUses = (r) => asArray(r).filter((e) => e.type === 'tool_use').map((e) => JSON.parse(e.data));

test('askUserHasQuestions predicate', () => {
  assert.equal(askUserHasQuestions(undefined), false);
  assert.equal(askUserHasQuestions(null), false);
  assert.equal(askUserHasQuestions({}), false);
  assert.equal(askUserHasQuestions({ questions: [] }), false);
  assert.equal(askUserHasQuestions({ questions: QUESTIONS }), true);
});

test('BUG CASE: AUQ input only in snapshot (no deltas) — synthesis defers, snapshot renders the card', () => {
  const emitted = new Set();
  const pending = new Map();
  const id = 'toolu_A';

  // 1. content_block_start → deferred, nothing emitted yet
  assert.equal(parseClaudeEvent(startEvt(0, id), emitted, false, pending), null);
  assert.ok(pending.has(0), 'pending entry created on content_block_start');

  // 2. content_block_stop with EMPTY partial → must NOT emit (defer to snapshot)
  assert.equal(parseClaudeEvent(stopEvt(0), emitted, false, pending), null, 'optionless synthesis returns null');
  assert.equal(emitted.has(id), false, 'tool id NOT marked emitted, so the snapshot can still emit it');

  // 3. assistant snapshot WITH questions → primary emission, full input, _update=false
  const snap = toolUses(parseClaudeEvent(snapshotEvt(id, { questions: QUESTIONS }), emitted, true, pending));
  assert.equal(snap.length, 1, 'snapshot emits the AUQ tool_use');
  assert.equal(snap[0].name, 'AskUserQuestion');
  assert.equal(snap[0]._update, false, 'snapshot is the primary (non-update) emission');
  assert.ok(askUserHasQuestions(snap[0].input), 'emitted input carries questions → card renders, suppression arms correctly');
});

test('WORKING CASE: AUQ input streamed as deltas — synthesis emits, snapshot deduped as _update (no regression)', () => {
  const emitted = new Set();
  const pending = new Map();
  const id = 'toolu_B';
  const json = JSON.stringify({ questions: QUESTIONS });
  const half = Math.floor(json.length / 2);

  assert.equal(parseClaudeEvent(startEvt(0, id), emitted, false, pending), null);
  assert.equal(parseClaudeEvent(deltaEvt(0, json.slice(0, half)), emitted, false, pending), null);
  assert.equal(parseClaudeEvent(deltaEvt(0, json.slice(half)), emitted, false, pending), null);

  const synth = toolUses(parseClaudeEvent(stopEvt(0), emitted, false, pending));
  assert.equal(synth.length, 1, 'synthesis emits the AUQ from accumulated deltas');
  assert.ok(askUserHasQuestions(synth[0].input), 'synthesized input carries questions');
  assert.equal(emitted.has(id), true, 'tool id marked emitted');

  const snap = toolUses(parseClaudeEvent(snapshotEvt(id, { questions: QUESTIONS }), emitted, true, pending));
  assert.equal(snap.length, 1);
  assert.equal(snap[0]._update, true, 'snapshot duplicate flagged as _update (client dedups, server suppresses)');
});

test('GUARD: malformed/truncated partial never yields a question-less emission', () => {
  const emitted = new Set();
  const pending = new Map();
  const id = 'toolu_C';
  parseClaudeEvent(startEvt(0, id), emitted, false, pending);
  parseClaudeEvent(deltaEvt(0, '{ "questions": ['), emitted, false, pending); // truncated JSON
  assert.equal(parseClaudeEvent(stopEvt(0), emitted, false, pending), null, 'malformed synthesis defers rather than emitting an empty card');
  assert.equal(emitted.has(id), false);
});
