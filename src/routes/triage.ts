// Decision 023 Phase 5 — Carryforward triage server-side fetch.
//
// `GET /api/triage/current?mode=work|personal` returns the same items[] shape
// the skill used to emit inline in the `<!--triage-menu:v1 {...}-->` marker.
// With this endpoint the LLM no longer has to stream item bodies + hashes; the
// frontend fetches the data directly the moment a minimal `{ "ref": "latest" }`
// marker arrives.
//
// Hash + verifier-extraction regexes are ported verbatim from
// `obsidian-mcp-server/src/tools/memory/verifyHandoffItems.ts` so the hashes
// returned here match what `tag_handoff_item` expects.
import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { parseMode, getVaultPath, getActiveModeVaults } from '../config';

const router = Router();

const BULLET_HEAD_STRIP_RE = /^\s*-\s+\[(?:\s|x|X|historical)\]\s+/;
const VERIFY_TAG_RE = /(?:^|[\s—-])(?:\*\*\s*)?verify(?:\s+[a-z]+)*\s*:\s*(?:\*\*\s*)?(.+)$/i;
const HANDOFF_SECTION_RE = /## Handoff\n\n([\s\S]*?)(?=\n## |\n---|$)/;
const BULLET_LINE_RE = /^- \[([^\]]+)\]\s+(.+)$/;

// Decision 024 — POST /api/triage/resolve. The constants below MUST stay in
// sync with the MCP-side `tag_handoff_item` implementation in
// obsidian-mcp-server/src/tools/session/tagHandoffItem.ts (mirror block at top
// of file). If the tagging format or section-header regex changes there, change
// it here too — or extract to a shared package.
const HANDOFF_HEADER_RE = /^##\s+(Handoff|Carryforward(?:\s+items)?)\s*$/i;
const ANY_H2_RE = /^##\s+/;
const CHECKBOX_BULLET_RE = /^(\s*-\s+)\[(?:\s|x|X)\]\s+(.*)$/;
const TAGGED_BODY_RE = /^(resolved|dismissed):(\d{4}-\d{2}-\d{2})\s+by\s+(\S+)/;
const FRONTMATTER_CATEGORY_RE = /^category:\s*["']?([^"'\n]+)["']?\s*$/m;
const RESOLVE_BY = 'chat-bridge'; // Decision 024: non-session attribution token

const RECENT_SESSION_LIMIT = 3;     // matches get_memory_base's handoff lookback
const MONTHS_TO_SCAN = 3;
const BODY_MAX_CHARS = 80;

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

function computeBulletIdHash(rawLine: string, verifierText: string | null): string {
  const stripped = rawLine.replace(BULLET_HEAD_STRIP_RE, '').trim();
  const verifier = verifierText?.trim();
  const basis = verifier && verifier.length > 0 ? `${stripped}\x00${verifier}` : stripped;
  return createHash('sha256').update(basis).digest('hex');
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

function scanRecentSessions(vaultPath: string, maxCount: number): Array<{ slug: string; filePath: string }> {
  const sessionsDir = path.join(vaultPath, 'sessions');
  const out: Array<{ slug: string; filePath: string }> = [];

  try {
    const months = fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a));

    for (const month of months.slice(0, MONTHS_TO_SCAN)) {
      const monthPath = path.join(sessionsDir, month);
      const files = fs.readdirSync(monthPath)
        .filter((f) => f.endsWith('.md'))
        .sort((a, b) => b.localeCompare(a));

      for (const file of files) {
        const slug = file.replace(/\.md$/, '');
        out.push({ slug, filePath: path.join(monthPath, file) });
        if (out.length >= maxCount) return out;
      }
    }
  } catch {}

  return out;
}

function truncateBody(s: string, max = BODY_MAX_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

function formatLocalDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function hashForBulletLine(line: string): string {
  const m = line.match(VERIFY_TAG_RE);
  const verifierText = m ? m[1].trim() : null;
  return computeBulletIdHash(line, verifierText);
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

  const sessions = scanRecentSessions(vaultPath, RECENT_SESSION_LIMIT);
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
  const m = matchedLine.match(CHECKBOX_BULLET_RE);
  if (!m) {
    res.status(500).json({ ok: false, error: 'internal', details: 'matched line lost checkbox shape' });
    return;
  }

  const tagged = m[2].match(TAGGED_BODY_RE);
  if (tagged) {
    res.json({
      ok: true,
      action_applied: 'noop',
      existing_tag: `${tagged[1]}:${tagged[2]} by ${tagged[3]}`,
    });
    return;
  }

  const today = formatLocalDate(new Date());
  const indent = m[1];
  const bodyText = m[2];
  const tagVerb = action === 'resolve' ? 'resolved' : 'dismissed';
  let newLine = `${indent}[x] ${tagVerb}:${today} by ${RESOLVE_BY} ${bodyText}`;
  if (notes && notes.trim()) {
    newLine += ` — note: ${notes.trim()}`;
  }
  lines[matchedLineIdx] = newLine;

  try {
    fs.writeFileSync(sessionFile, lines.join('\n'), 'utf-8');
  } catch (err) {
    res.status(500).json({ ok: false, error: 'write_failed', details: (err as Error).message });
    return;
  }

  const preview = bodyText.length > 80 ? bodyText.slice(0, 77) + '...' : bodyText;
  res.json({
    ok: true,
    action_applied: action,
    session_file: sessionFile,
    tagged_at: today,
    by: RESOLVE_BY,
    bullet_preview: preview,
  });
});

export default router;
