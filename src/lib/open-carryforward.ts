// Decision 028 Phase 3 — canonical `open-carryforward.md` reader/writer for the
// bridge. Mirrors the MCP-side parser at
// obsidian-mcp-server/src/tools/memory/openCarryforward.ts. Format details
// (frontmatter, `## Open Items`, `<!--meta hash:... -->` blocks) MUST match —
// if MCP's parser changes, change this one too.
//
// Parser bug fix vs MCP (2026-05-22): the MCP regex uses non-greedy `.+?`
// which matches the FIRST `<!--meta ...-->` on a line. Bullets whose BODY
// contains a literal example of the meta block (e.g. spec bullets in
// backticks) get parsed wrong — meta extracted from the example, not the
// trailing real block. We (a) anchor to end-of-line and (b) forbid `<` in the
// capture, so the engine is forced to match only the LAST `<!--meta...-->` on
// the line. The dict-overwrite-last-wins semantic of `parseMetaBlock` masked
// this partly — hash/origin happened to be correct — but body extraction and
// verifier parsing were both broken.
import fs from 'fs';
import path from 'path';
import {
  CHECKBOX_BULLET_RE,
  VERIFY_TAG_RE,
  formatLocalDate,
  RESOLVE_BY_CHAT_BRIDGE,
  type TagAction,
} from './handoff-tagging';

export const OPEN_CARRYFORWARD_FILENAME = 'open-carryforward.md';

export type CarryforwardKind =
  | 'historical'
  | 'verify-command'
  | 'verify-prose'
  | 'untagged-forward-looking';

export interface OpenCarryforwardItem {
  rawLine: string;
  body: string;
  verifier: string | null;
  hash: string;
  origin: string;
  cwd: string;
  created: string;
  kind: CarryforwardKind;
}

export function openCarryforwardPath(vaultPath: string): string {
  return path.join(vaultPath, OPEN_CARRYFORWARD_FILENAME);
}

const SECTION_HEADER_RE = /^##\s+Open\s+Items\s*$/i;
const ANY_H2_RE = /^##\s+/;
const OPEN_CHECKBOX_RE = /^\s*-\s+\[\s\]\s+/;
// End-of-line anchor + `[^<]` capture forces the engine to land on the LAST
// `<!--meta ...-->` on the line. See top-of-file comment for rationale.
const META_BLOCK_RE = /<!--meta\s+([^<]+?)\s+-->\s*$/;
const HEAD_STRIP_RE = /^\s*-\s+\[(?:\s|x|X|historical)\]\s+/;
const REGEX_SPECIAL_RE = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(s: string): string {
  return s.replace(REGEX_SPECIAL_RE, (m) => '\\' + m);
}

function parseMetaBlock(metaBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of metaBody.split(/\s+/)) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    const key = part.slice(0, colon);
    const value = part.slice(colon + 1);
    if (key && value) out[key] = value;
  }
  return out;
}

interface SectionRange {
  startLine: number;
  endLine: number;
}

function findOpenItemsSection(lines: string[]): SectionRange | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SECTION_HEADER_RE.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (ANY_H2_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { startLine: start, endLine: end };
}

function extractVerifier(cleaned: string): { verifier: string | null; body: string } {
  const m = cleaned.match(VERIFY_TAG_RE);
  if (!m || m.index === undefined) return { verifier: null, body: cleaned.trim() };
  const verifier = m[1].replace(/\*\*\s*$/, '').trim();
  const body = cleaned.slice(0, m.index).trim();
  return { verifier, body };
}

function classifyKind(verifier: string | null, metaKind: string | undefined): CarryforwardKind {
  if (
    metaKind === 'verify-command' ||
    metaKind === 'verify-prose' ||
    metaKind === 'untagged-forward-looking' ||
    metaKind === 'historical'
  ) {
    return metaKind;
  }
  if (verifier === null) return 'untagged-forward-looking';
  return /^`/.test(verifier) ? 'verify-command' : 'verify-prose';
}

// Read the canonical file and return only active (`[ ]`) items. Items missing
// a meta block or hash are skipped silently — the migration script guarantees
// all migrated items have meta, and writers in this module emit meta for all
// new items.
export function readOpenCarryforward(vaultPath: string): OpenCarryforwardItem[] {
  const filePath = openCarryforwardPath(vaultPath);
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return [];
    throw err;
  }

  const lines = content.split(/\r?\n/);
  const section = findOpenItemsSection(lines);
  if (!section) return [];

  const items: OpenCarryforwardItem[] = [];
  for (let i = section.startLine + 1; i < section.endLine; i++) {
    const line = lines[i];
    if (!OPEN_CHECKBOX_RE.test(line)) continue;

    const metaMatch = line.match(META_BLOCK_RE);
    if (!metaMatch) continue;
    const meta = parseMetaBlock(metaMatch[1]);
    if (!meta.hash) continue;

    const cleaned = line.replace(HEAD_STRIP_RE, '').replace(META_BLOCK_RE, '').trim();
    const { verifier, body } = extractVerifier(cleaned);
    const kind = classifyKind(verifier, meta.kind);

    items.push({
      rawLine: line,
      body,
      verifier,
      hash: meta.hash,
      origin: meta.origin ?? '',
      cwd: meta.cwd ?? '',
      created: meta.created ?? '',
      kind,
    });
  }
  return items;
}

export interface DeletedResolveResult {
  kind: 'deleted';
  filePath: string;
  deletedAt: string;
  by: string;
  bulletPreview: string;
}

export type ResolveCanonicalResult =
  | DeletedResolveResult
  | { kind: 'bullet_not_found' }
  | { kind: 'file_not_found' };

// Decision 029 — delete the matched bullet line entirely instead of tagging
// it `[x] resolved:DATE`. Audit trail lives in the originating session file's
// `## Closing notes` block. `action` and `notes` are
// accepted for API back-compat
// but are no longer load-bearing (resolve and dismiss both delete; there's no
// body left to annotate with notes).
//
// Idempotent at the file level: a second call against the same hash returns
// `bullet_not_found`. Callers wanting HTTP-level idempotency should treat
// `bullet_not_found` as success.
export function resolveInCanonical(
  vaultPath: string,
  hash: string,
  _action: TagAction,
  attribution: string = RESOLVE_BY_CHAT_BRIDGE,
  _notes?: string,
  today: string = formatLocalDate(),
): ResolveCanonicalResult {
  const filePath = openCarryforwardPath(vaultPath);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return { kind: 'file_not_found' };
    throw err;
  }

  const lines = raw.split('\n');
  // The hash is interpolated into a regex; escape regex specials defensively
  // even though the route layer validates the 64-hex format.
  const hashCheck = new RegExp('\\bhash:' + escapeRegex(hash) + '\\b');
  let matchedIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const metaMatch = lines[i].match(META_BLOCK_RE);
    if (!metaMatch) continue;
    if (hashCheck.test(metaMatch[1])) {
      matchedIdx = i;
      break;
    }
  }
  if (matchedIdx === -1) return { kind: 'bullet_not_found' };

  // Capture a preview of the body before splicing the line out.
  const cb = lines[matchedIdx].match(CHECKBOX_BULLET_RE);
  const rawBody = cb ? cb[2] : '';
  const cleanedBody = rawBody
    .replace(META_BLOCK_RE, '')
    .replace(VERIFY_TAG_RE, '')
    .trim();
  const bulletPreview = cleanedBody.length > 80 ? cleanedBody.slice(0, 77) + '...' : cleanedBody;

  lines.splice(matchedIdx, 1);
  atomicWrite(filePath, lines.join('\n'));

  return {
    kind: 'deleted',
    filePath,
    deletedAt: today,
    by: attribution,
    bulletPreview,
  };
}

function atomicWrite(targetPath: string, content: string): void {
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, targetPath);
}
