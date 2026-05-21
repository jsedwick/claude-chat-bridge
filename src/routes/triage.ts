// Decision 023 Phase 5 — Carryforward triage server-side fetch.
// Decision 024 — bridge-direct triage resolve (POST /api/triage/resolve).
// Decision 025 — tagging primitives now live in src/lib/handoff-tagging.ts and
// are shared with src/routes/sessions.ts (Open Items panel resolve).
// Decision 026 — session selection mirrors the MCP-side algorithm so the
// bridge's items[] matches what `get_memory_base.handoffs[].items[]` would
// surface for the same `working_directory`. If the algorithm changes in
// obsidian-mcp-server/src/tools/memory/getMemoryBase.ts (`extractRecentHandoffs`),
// change it here too.
//
// `GET /api/triage/current?mode=work|personal[&working_directory=<abs-path>]`
// returns the same items[] shape the skill used to emit inline in the
// `<!--triage-menu:v1 {...}-->` marker. When `working_directory` is omitted, we
// fall back to filename-DESC selection (legacy behavior).
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { parseMode, getVaultPath, getActiveModeVaults } from '../config';
import {
  BULLET_LINE_RE,
  CHECKBOX_BULLET_RE,
  VERIFY_TAG_RE,
  RESOLVE_BY_CHAT_BRIDGE,
  computeBulletIdHash,
  hashForBulletLine,
  applyResolveTag,
  formatLocalDate,
} from '../lib/handoff-tagging';

const router = Router();

const HANDOFF_SECTION_RE = /## Handoff\n\n([\s\S]*?)(?=\n## |\n---|$)/;
const HANDOFF_HEADER_RE = /^##\s+(Handoff|Carryforward(?:\s+items)?)\s*$/i;
const ANY_H2_RE = /^##\s+/;
const FRONTMATTER_CATEGORY_RE = /^category:\s*["']?([^"'\n]+)["']?\s*$/m;

const RECENT_SESSION_LIMIT = 3;     // matches get_memory_base's handoff lookback
const MONTHS_TO_SCAN = 3;
const BODY_MAX_CHARS = 80;
// Decision 026 — mirrors MCP's `scanLimit = Math.min(allSessionFiles.length, 20)`
// in extractRecentHandoffs. Cap on how deep to look for `working_directory`
// matches before falling back to "fill with most-recent overall."
const CWD_SCAN_LIMIT = 20;
const FRONTMATTER_WD_RE = /working_directory:\s*"?([^"\n]+?)"?\s*$/m;

interface TriageItem {
  n: number;
  body: string;
  slug: string;
  hash: string;
}

type BulletKind = 'historical' | 'verify-command' | 'verify-prose' | 'untagged-forward-looking';

interface ParsedBullet {
  rawLine: string;
  body: string;
  verifier: string | null;
  kind: BulletKind;
  resolved: boolean;
  hash: string;
}

function parseHandoffBullets(handoff: string): ParsedBullet[] {
  const out: ParsedBullet[] = [];
  for (const rawLine of handoff.split('\n')) {
    const m = rawLine.match(BULLET_LINE_RE);
    if (!m) continue;
    const tag = m[1].trim();
    const bodyAndVerifier = m[2].trim();
    const resolved = tag === 'historical' || tag === 'x' || tag === 'X';

    const verifyMatch = bodyAndVerifier.match(VERIFY_TAG_RE);
    const verifier = verifyMatch ? verifyMatch[1].trim() : null;
    const verifierIdx = verifyMatch ? bodyAndVerifier.indexOf(verifyMatch[0]) : -1;
    const body = verifierIdx >= 0 ? bodyAndVerifier.slice(0, verifierIdx).trim() : bodyAndVerifier;

    let kind: BulletKind;
    if (resolved) kind = 'historical';
    else if (verifier) kind = /^`/.test(verifier) ? 'verify-command' : 'verify-prose';
    else kind = 'untagged-forward-looking';

    const hash = computeBulletIdHash(rawLine, verifier);
    out.push({ rawLine, body, verifier, kind, resolved, hash });
  }
  return out;
}

function readHandoffSection(sessionFilePath: string): string | null {
  try {
    const content = fs.readFileSync(sessionFilePath, 'utf-8');
    const match = content.match(HANDOFF_SECTION_RE);
    if (!match || !match[1].trim() || match[1].trim() === '_No handoff notes_') return null;
    return match[1].trim();
  } catch {
    return null;
  }
}

// Decision 026 — collect all session files across the scanned month directories
// with their mtimes, sorted DESC. Mirrors MCP's flat-list-with-mtime approach in
// `extractRecentHandoffs` so both sides see the same "most-recent" ordering even
// when a recent retag-via-resolve updates an older session's mtime.
function collectSessionFilesByMtime(vaultPath: string): Array<{ slug: string; filePath: string; mtimeMs: number }> {
  const sessionsDir = path.join(vaultPath, 'sessions');
  const out: Array<{ slug: string; filePath: string; mtimeMs: number }> = [];

  try {
    const months = fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a))
      .slice(0, MONTHS_TO_SCAN);

    for (const month of months) {
      const monthPath = path.join(sessionsDir, month);
      let files: string[];
      try {
        files = fs.readdirSync(monthPath).filter((f) => f.endsWith('.md'));
      } catch {
        continue;
      }
      for (const file of files) {
        const filePath = path.join(monthPath, file);
        try {
          const stat = fs.statSync(filePath);
          out.push({
            slug: file.replace(/\.md$/, ''),
            filePath,
            mtimeMs: stat.mtimeMs,
          });
        } catch {
          continue;
        }
      }
    }
  } catch {}

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// Decision 026 — read the `working_directory:` frontmatter field from a session
// file. Returns null if missing/unreadable/malformed. Mirrors the regex used by
// MCP's `extractRecentHandoffs` two-pass CWD partition.
function readSessionWorkingDirectory(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const wdMatch = fmMatch[1].match(FRONTMATTER_WD_RE);
    return wdMatch ? wdMatch[1].trim() : null;
  } catch {
    return null;
  }
}

// Decision 026 — pick `maxCount` sessions using MCP-parity logic:
//   - With workingDir: scan the top CWD_SCAN_LIMIT mtime-sorted sessions,
//     partition into CWD-matches vs others, fill CWD-matches first then
//     others. Mirrors `extractRecentHandoffs` exactly.
//   - Without workingDir: just take the top `maxCount` by mtime. Legacy
//     callers (skill markers without `working_directory` field) land here.
function scanRecentSessions(
  vaultPath: string,
  maxCount: number,
  workingDir?: string,
): Array<{ slug: string; filePath: string }> {
  const all = collectSessionFilesByMtime(vaultPath);

  if (!workingDir) {
    return all.slice(0, maxCount).map(({ slug, filePath }) => ({ slug, filePath }));
  }

  const scanLimit = Math.min(all.length, CWD_SCAN_LIMIT);
  const cwdMatches: Array<{ slug: string; filePath: string }> = [];
  const others: Array<{ slug: string; filePath: string }> = [];
  for (let i = 0; i < scanLimit; i++) {
    const entry = all[i];
    const sessionWd = readSessionWorkingDirectory(entry.filePath);
    const bucket = sessionWd === workingDir ? cwdMatches : others;
    bucket.push({ slug: entry.slug, filePath: entry.filePath });
  }

  const selected: Array<{ slug: string; filePath: string }> = [];
  for (const p of cwdMatches) {
    if (selected.length >= maxCount) break;
    selected.push(p);
  }
  for (const p of others) {
    if (selected.length >= maxCount) break;
    selected.push(p);
  }
  return selected;
}

function truncateBody(s: string, max = BODY_MAX_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

// Filter rule (Phase 5+): the bridge can't run verify-command verifiers, so it
// can't tell ambiguous-result items apart from absence-grep-resolved ones the
// MCP server would suppress. To keep this endpoint's numbering consistent with
// what Claude's skill sees, we restrict triage-eligibility to `verify-prose`
// and `untagged-forward-looking` only. verify-command items, if any, remain
// resolvable via the CLI `<N> resolve` path through Claude's in-context map.
function isTriageEligible(bullet: ParsedBullet): boolean {
  if (bullet.resolved) return false;
  return bullet.kind === 'verify-prose' || bullet.kind === 'untagged-forward-looking';
}

router.get('/current', (req: Request, res: Response) => {
  const mode = parseMode(req.query.mode);
  if (!mode) {
    res.status(400).json({ error: 'mode query param required: "work" or "personal"' });
    return;
  }

  let vaultPath: string;
  try {
    vaultPath = getVaultPath(mode);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
    return;
  }

  // Decision 026 — optional `working_directory` triggers MCP-parity selection.
  // Skill markers populated from the Claude Code session env carry this; older
  // clients that omit it fall back to mtime-DESC across all recent sessions.
  const workingDir =
    typeof req.query.working_directory === 'string' && req.query.working_directory
      ? req.query.working_directory
      : undefined;

  const sessions = scanRecentSessions(vaultPath, RECENT_SESSION_LIMIT, workingDir);
  const items: TriageItem[] = [];
  let n = 1;

  for (const { slug, filePath } of sessions) {
    const handoff = readHandoffSection(filePath);
    if (!handoff) continue;

    const bullets = parseHandoffBullets(handoff);
    for (const b of bullets) {
      if (!isTriageEligible(b)) continue;
      items.push({
        n: n++,
        body: truncateBody(b.body),
        slug,
        hash: b.hash,
      });
    }
  }

  res.json({ items });
});

// Decision 024 — bridge-direct triage resolve.
// POST /api/triage/resolve { mode, slug, hash, action, notes? }
//
// Mutates the source session file in-place: finds the bullet whose
// computeBulletIdHash matches, flips `[ ]` → `[x]`, prepends
// `resolved:DATE by chat-bridge` (or `dismissed:`). This bypasses the LLM path
// for mechanical resolves so session-start latency isn't blocked on the LLM
// holding an n→hash map in working context.
//
// Parallel implementation lives in
// obsidian-mcp-server/src/tools/session/tagHandoffItem.ts. The regex constants
// + tagging format MUST match that file (see mirror block above).
router.post('/resolve', (req: Request, res: Response) => {
  const body = req.body || {};
  const mode = parseMode(body.mode);
  if (!mode) {
    res.status(400).json({ ok: false, error: 'invalid_mode', details: 'mode must be "work" or "personal"' });
    return;
  }
  if (typeof body.slug !== 'string' || !body.slug) {
    res.status(400).json({ ok: false, error: 'missing_slug' });
    return;
  }
  if (typeof body.hash !== 'string' || !body.hash) {
    res.status(400).json({ ok: false, error: 'missing_hash' });
    return;
  }
  if (body.action !== 'resolve' && body.action !== 'dismiss') {
    res.status(400).json({ ok: false, error: 'invalid_action', details: 'action must be "resolve" or "dismiss"' });
    return;
  }

  const slug: string = body.slug;
  const hash: string = body.hash;
  const action: 'resolve' | 'dismiss' = body.action;
  const notes: string | undefined = typeof body.notes === 'string' ? body.notes : undefined;

  const monthDir = slug.slice(0, 7); // YYYY-MM
  const vaults = getActiveModeVaults(mode);
  let sessionFile: string | null = null;
  for (const v of vaults) {
    const candidate = path.join(v.path, 'sessions', monthDir, `${slug}.md`);
    if (fs.existsSync(candidate)) {
      sessionFile = candidate;
      break;
    }
  }
  if (!sessionFile) {
    res.status(404).json({
      ok: false,
      error: 'session_not_found',
      details: `no sessions/${monthDir}/${slug}.md in any ${mode} vault`,
    });
    return;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile, 'utf-8');
  } catch (err) {
    res.status(500).json({ ok: false, error: 'read_failed', details: (err as Error).message });
    return;
  }

  if (raw.startsWith('---\n')) {
    const close = raw.indexOf('\n---', 4);
    if (close < 0) {
      res.status(400).json({ ok: false, error: 'frontmatter_malformed', details: 'unterminated YAML frontmatter' });
      return;
    }
    const fmBody = raw.slice(4, close);
    const catMatch = fmBody.match(FRONTMATTER_CATEGORY_RE);
    const category = catMatch ? catMatch[1].trim() : undefined;
    if (category && category !== 'session') {
      res.status(400).json({
        ok: false,
        error: 'scope_violation',
        details: `frontmatter category is "${category}", not "session"`,
      });
      return;
    }
  }

  const lines = raw.split('\n');

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (HANDOFF_HEADER_RE.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    res.status(404).json({ ok: false, error: 'bullet_not_found', details: 'no handoff section in source file' });
    return;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (ANY_H2_RE.test(lines[i])) {
      end = i;
      break;
    }
  }

  let matchedLineIdx = -1;
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    if (!CHECKBOX_BULLET_RE.test(line)) continue;
    if (hashForBulletLine(line) === hash) {
      matchedLineIdx = i;
      break;
    }
  }
  if (matchedLineIdx === -1) {
    res.status(404).json({
      ok: false,
      error: 'bullet_not_found',
      details: `no bullet in handoff hashes to ${hash.slice(0, 12)}...`,
    });
    return;
  }

  const matchedLine = lines[matchedLineIdx];
  const today = formatLocalDate();
  const tagResult = applyResolveTag(matchedLine, action, RESOLVE_BY_CHAT_BRIDGE, today, notes);

  if (tagResult.kind === 'not_checkbox') {
    res.status(500).json({ ok: false, error: 'internal', details: 'matched line lost checkbox shape' });
    return;
  }
  if (tagResult.kind === 'noop') {
    res.json({
      ok: true,
      action_applied: 'noop',
      existing_tag: tagResult.existing_tag,
    });
    return;
  }

  lines[matchedLineIdx] = tagResult.newLine;

  try {
    fs.writeFileSync(sessionFile, lines.join('\n'), 'utf-8');
  } catch (err) {
    res.status(500).json({ ok: false, error: 'write_failed', details: (err as Error).message });
    return;
  }

  // For the preview field, re-extract the original body from the matched line.
  const cbMatch = matchedLine.match(CHECKBOX_BULLET_RE);
  const bodyText = cbMatch ? cbMatch[2] : '';
  const preview = bodyText.length > 80 ? bodyText.slice(0, 77) + '...' : bodyText;
  res.json({
    ok: true,
    action_applied: action,
    session_file: sessionFile,
    tagged_at: today,
    by: RESOLVE_BY_CHAT_BRIDGE,
    bullet_preview: preview,
  });
});

export default router;
