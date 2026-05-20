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
import { parseMode, getVaultPath } from '../config';

const router = Router();

const BULLET_HEAD_STRIP_RE = /^\s*-\s+\[(?:\s|x|X|historical)\]\s+/;
const VERIFY_TAG_RE = /(?:^|[\s—-])(?:\*\*\s*)?verify(?:\s+[a-z]+)*\s*:\s*(?:\*\*\s*)?(.+)$/i;
const HANDOFF_SECTION_RE = /## Handoff\n\n([\s\S]*?)(?=\n## |\n---|$)/;
const BULLET_LINE_RE = /^- \[([^\]]+)\]\s+(.+)$/;

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

export default router;
