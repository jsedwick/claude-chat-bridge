// Decision 025 — shared handoff-bullet tagging primitives used by:
//   - src/routes/triage.ts        (POST /api/triage/resolve, hash-keyed)
//   - src/routes/sessions.ts      (PATCH /:id/carryforward/resolve, text-keyed
//                                  from the Open Items panel)
//
// Mirror block — keep in sync with the MCP-side `tag_handoff_item` impl at
// obsidian-mcp-server/src/tools/session/tagHandoffItem.ts. If the tagging
// format, regex constants, or hash algorithm change there, change them here.
import { createHash } from 'crypto';

export const BULLET_HEAD_STRIP_RE = /^\s*-\s+\[(?:\s|x|X|historical)\]\s+/;
export const VERIFY_TAG_RE = /(?:^|[\s—-])(?:\*\*\s*)?verify(?:\s+[a-z]+)*\s*:\s*(?:\*\*\s*)?(.+)$/i;
export const BULLET_LINE_RE = /^- \[([^\]]+)\]\s+(.+)$/;
export const CHECKBOX_BULLET_RE = /^(\s*-\s+)\[(?:\s|x|X)\]\s+(.*)$/;
// Captures: 1=verb(resolved|dismissed) 2=YYYY-MM-DD 3=attribution 4=rest (body + optional note)
export const TAGGED_BODY_RE = /^(resolved|dismissed):(\d{4}-\d{2}-\d{2})\s+by\s+(\S+)(?:\s+(.*))?$/;
export const RESOLVE_BY_CHAT_BRIDGE = 'chat-bridge';

export function computeBulletIdHash(rawLine: string, verifierText: string | null): string {
  const stripped = rawLine.replace(BULLET_HEAD_STRIP_RE, '').trim();
  const verifier = verifierText?.trim();
  const basis = verifier && verifier.length > 0 ? `${stripped}\x00${verifier}` : stripped;
  return createHash('sha256').update(basis).digest('hex');
}

export function hashForBulletLine(line: string): string {
  const m = line.match(VERIFY_TAG_RE);
  const verifierText = m ? m[1].trim() : null;
  return computeBulletIdHash(line, verifierText);
}

export function formatLocalDate(d: Date = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export type TagAction = 'resolve' | 'dismiss';

export type ApplyTagResult =
  | { kind: 'tagged'; newLine: string }
  | { kind: 'noop'; existing_tag: string }
  | { kind: 'not_checkbox' };

// Rewrites a single bullet line with `[x] resolved:DATE by ATTRIBUTION ...` (or
// `dismissed:`). Idempotent: if the line is already tagged, returns noop with
// the existing tag string.
export function applyResolveTag(
  line: string,
  action: TagAction,
  attribution: string,
  today: string = formatLocalDate(),
  notes?: string,
): ApplyTagResult {
  const m = line.match(CHECKBOX_BULLET_RE);
  if (!m) return { kind: 'not_checkbox' };

  const indent = m[1];
  const bodyText = m[2];

  const tagged = bodyText.match(TAGGED_BODY_RE);
  if (tagged) {
    return { kind: 'noop', existing_tag: `${tagged[1]}:${tagged[2]} by ${tagged[3]}` };
  }

  const tagVerb = action === 'resolve' ? 'resolved' : 'dismissed';
  let newLine = `${indent}[x] ${tagVerb}:${today} by ${attribution} ${bodyText}`;
  if (notes && notes.trim()) {
    newLine += ` — note: ${notes.trim()}`;
  }
  return { kind: 'tagged', newLine };
}

// Strips a Decision 023 `resolved:DATE by X ...` / `dismissed:DATE by X ...`
// prefix from a bullet body for display purposes. Returns the original body
// unchanged when no prefix is present.
export interface StripResult {
  displayBody: string;
  note?: string;
  tag?: { action: 'resolved' | 'dismissed'; date: string; by: string };
}

export function stripResolveTag(bodyText: string): StripResult {
  const m = bodyText.match(TAGGED_BODY_RE);
  if (!m) return { displayBody: bodyText };
  const rest = (m[4] ?? '').trim();
  const noteIdx = rest.indexOf(' — note: ');
  const displayBody = noteIdx >= 0 ? rest.slice(0, noteIdx).trim() : rest;
  const note = noteIdx >= 0 ? rest.slice(noteIdx + ' — note: '.length).trim() : undefined;
  return {
    displayBody: displayBody || rest,
    note,
    tag: { action: m[1] as 'resolved' | 'dismissed', date: m[2], by: m[3] },
  };
}
