// Decision 023 Phase 5 — Carryforward triage server-side fetch.
// Decision 024 — bridge-direct triage resolve (POST /api/triage/resolve).
// Decision 025 — tagging primitives now live in src/lib/handoff-tagging.ts and
// are shared with src/routes/sessions.ts (Open Items panel resolve).
// Decision 026 — session selection mirrors the MCP-side algorithm so the
// bridge's items[] matches what `get_memory_base.handoffs[].items[]` would
// surface for the same `working_directory`.
// Decision 028 Phase 3 — source/target switched from per-session `## Handoff`
// blocks to the canonical `open-carryforward.md` file per active mode. The
// `slug` returned in each TriageItem is the bullet's `origin:` meta (the
// session that first surfaced the item); cross-mode/back-compat fields in the
// resolve POST body are accepted but no longer load-bearing.
//
// `GET /api/triage/current?mode=work|personal[&working_directory=<abs-path>]`
// returns triage-eligible items from the canonical file. When `working_directory`
// is provided, items are bucket-sorted: CWD-match first (via `cwd:` meta), then
// ambient, then cross-CWD ("anti") items. Without `working_directory` the order
// is original document order.
import { Router, Request, Response } from 'express';
import { parseMode, getVaultPath } from '../config';
import { RESOLVE_BY_CHAT_BRIDGE } from '../lib/handoff-tagging';
import {
  readOpenCarryforward,
  resolveInCanonical,
  type OpenCarryforwardItem,
} from '../lib/open-carryforward';

const router = Router();

const BODY_MAX_CHARS = 80;

// Decision 024 follow-up — passive LLM notification of bridge-direct resolves.
// When the user checks rows + clicks Submit, the frontend POSTs to /resolve
// (Decision 024) which bypasses the LLM. The LLM's in-memory `triage_items[]`
// view (loaded at /vault:mb time) goes stale until the next memory-base load.
// To keep the LLM's view fresh within the same session, this queue collects
// the Ns that were resolved between LLM turns; chat.ts drains it before
// forwarding the next user message and prepends a
// `<!--triage-update:v1 {"removed":[N,...]}-->` HTML comment to the message.
// Keyed by appSessionId so resolves from one chat tab don't leak into another.
const pendingTriageMarkers = new Map<string, Set<number>>();

export function drainPendingTriageMarkers(appSessionId: string): number[] {
  const set = pendingTriageMarkers.get(appSessionId);
  if (!set || set.size === 0) return [];
  const out = Array.from(set).sort((a, b) => a - b);
  pendingTriageMarkers.delete(appSessionId);
  return out;
}

interface TriageItem {
  n: number;
  body: string;       // truncated for default display (BODY_MAX_CHARS)
  full_body: string;  // untruncated; frontend swaps to this on click-to-expand
  slug: string;       // bullet's `origin:` meta — the session that first surfaced it
  hash: string;
  // Decision 029 follow-up — true if the item's cwd is bidirectionally
  // path-related to the active session's working_directory. Powers the
  // frontend's "current working directory only" filter checkbox. When the
  // request was made without `working_directory`, all items have cwd_match=false.
  cwd_match: boolean;
}

function truncateBody(s: string, max = BODY_MAX_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

// Decision 027 — bias display order toward items whose CWD meta matches the
// active working directory. Items without a `cwd:` meta or with an unrelated
// path fall to "ambient"; items whose `cwd:` points at a different
// /Users/.../Projects/ path (or whose body literally mentions one) fall to
// "anti" so the most relevant items surface first.
//
// Decision 029 follow-up — the "match" rule is bidirectional path containment:
// the session's working directory is at-or-below the item's cwd, OR the item's
// cwd is at-or-below the session's. This is broader than strict equality and
// catches the common case where the session is in a subdirectory of a project
// the item was created in (or vice versa). The frontend's CWD-filter checkbox
// uses the same definition via the `cwd_match` field in the response.
type CwdRelevance = 'match' | 'ambient' | 'anti';

function pathContains(parent: string, child: string): boolean {
  if (!parent || !child) return false;
  if (parent === child) return true;
  const normalized = parent.endsWith('/') ? parent : parent + '/';
  return child.startsWith(normalized);
}

function isCwdRelated(itemCwd: string, sessionCwd: string): boolean {
  return pathContains(itemCwd, sessionCwd) || pathContains(sessionCwd, itemCwd);
}

function classifyCwdRelevance(item: OpenCarryforwardItem, cwd: string): CwdRelevance {
  // Check item.cwd AND body-text together — either matching is a strong
  // relevance signal. Previously body-text was a fallback only when item.cwd
  // was missing, which missed cross-cutting items: an MCP fix written from a
  // chat-bridge cwd would have cwd:chat-bridge in meta but mention the
  // obsidian-mcp-server path in its body, and the body signal was discarded.
  const cwdMatchesByMeta = item.cwd ? isCwdRelated(item.cwd, cwd) : false;
  const cwdMatchesByBody =
    item.rawLine.includes(cwd + '/') || item.rawLine.includes(cwd + '`') ||
    item.rawLine.includes(cwd + ' ') || item.rawLine.endsWith(cwd);
  if (cwdMatchesByMeta || cwdMatchesByBody) return 'match';

  if (item.cwd && /^\/Users\/[^/]+\/Projects\/[^/]+/.test(item.cwd)) return 'anti';
  if (/\/Users\/[^/\s]+\/Projects\/[^/`\s)]+/.test(item.rawLine)) return 'anti';
  return 'ambient';
}

// Filter rule (Phase 5+ from Decision 023): the bridge can't run verify-command
// verifiers, so it can't tell ambiguous-result items apart from absence-grep-
// resolved ones the MCP server would suppress. To keep this endpoint's
// numbering consistent with what Claude's skill sees, we restrict triage-
// eligibility to `verify-prose` and `untagged-forward-looking` only.
function isTriageEligible(item: OpenCarryforwardItem): boolean {
  return item.kind === 'verify-prose' || item.kind === 'untagged-forward-looking';
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

  let allItems: OpenCarryforwardItem[];
  try {
    allItems = readOpenCarryforward(vaultPath);
  } catch (err) {
    res.status(500).json({ error: `read_open_carryforward_failed: ${(err as Error).message}` });
    return;
  }

  const workingDir =
    typeof req.query.working_directory === 'string' && req.query.working_directory
      ? req.query.working_directory
      : undefined;

  // Body-dedup: the canonical file deduplicates by hash at write time, but
  // hash-distinct items may share an identical user-facing body (e.g. an item
  // re-carried with slight verifier-wording drift across closes). Collapse on
  // body to match the LLM-side `get_memory_base.triage_items[]` behavior.
  type Entry = { body: string; fullBody: string; slug: string; hash: string; rel: CwdRelevance };
  const matchBucket: Entry[] = [];
  const ambientBucket: Entry[] = [];
  const antiBucket: Entry[] = [];
  const seenBodies = new Set<string>();

  for (const item of allItems) {
    if (!isTriageEligible(item)) continue;
    if (seenBodies.has(item.body)) continue;
    seenBodies.add(item.body);

    const entry: Entry = {
      body: truncateBody(item.body),
      fullBody: item.body,
      slug: item.origin,
      hash: item.hash,
      rel: workingDir ? classifyCwdRelevance(item, workingDir) : 'ambient',
    };

    if (workingDir) {
      if (entry.rel === 'match') matchBucket.push(entry);
      else if (entry.rel === 'anti') antiBucket.push(entry);
      else ambientBucket.push(entry);
    } else {
      ambientBucket.push(entry);
    }
  }

  const ordered: Entry[] = workingDir
    ? [...matchBucket, ...ambientBucket, ...antiBucket]
    : ambientBucket;

  const items: TriageItem[] = ordered.map((e, i) => ({
    n: i + 1,
    body: e.body,
    full_body: e.fullBody,
    slug: e.slug,
    hash: e.hash,
    cwd_match: e.rel === 'match',
  }));

  res.json({ items });
});

// Per-vault write serialization. Frontend buckets resolves by source slug
// (legacy from when each resolve mutated a different session file), but the
// canonical-file model writes one file per mode — every concurrent resolve
// races on the same target. We chain writes via a per-vault Promise so
// frontend parallelism is safe at the HTTP layer.
const vaultWriteQueue = new Map<string, Promise<unknown>>();
function chainOnVault<T>(vaultPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = vaultWriteQueue.get(vaultPath) || Promise.resolve();
  const next = prev.catch(() => undefined).then(() => fn());
  vaultWriteQueue.set(vaultPath, next);
  return next;
}

// Decision 024 + 028 Phase 3 — bridge-direct resolve against the canonical
// `open-carryforward.md`. The legacy `slug` field is accepted for back-compat
// but ignored — we locate the bullet by `hash` in the canonical file's meta
// blocks. The response keeps the same shape returned pre-Phase-3 to avoid
// breaking the frontend's `json.ok` check.
//
// Parallel implementation lives in
// obsidian-mcp-server/src/tools/memory/resolveCarryforwardItem.ts. The hash
// match + tagging format MUST stay aligned with that file.
router.post('/resolve', async (req: Request, res: Response) => {
  const body = req.body || {};
  const mode = parseMode(body.mode);
  if (!mode) {
    res.status(400).json({ ok: false, error: 'invalid_mode', details: 'mode must be "work" or "personal"' });
    return;
  }
  if (typeof body.hash !== 'string' || !body.hash) {
    res.status(400).json({ ok: false, error: 'missing_hash' });
    return;
  }
  if (!/^[a-f0-9]{64}$/i.test(body.hash)) {
    res.status(400).json({ ok: false, error: 'invalid_hash', details: 'hash must be 64-char SHA-256 hex' });
    return;
  }
  if (body.action !== 'resolve' && body.action !== 'dismiss') {
    res.status(400).json({ ok: false, error: 'invalid_action', details: 'action must be "resolve" or "dismiss"' });
    return;
  }

  const hash: string = body.hash;
  const action: 'resolve' | 'dismiss' = body.action;
  const notes: string | undefined = typeof body.notes === 'string' ? body.notes : undefined;

  let vaultPath: string;
  try {
    vaultPath = getVaultPath(mode);
  } catch (err) {
    res.status(500).json({ ok: false, error: 'vault_lookup_failed', details: (err as Error).message });
    return;
  }

  try {
    const result = await chainOnVault(vaultPath, async () =>
      resolveInCanonical(vaultPath, hash, action, RESOLVE_BY_CHAT_BRIDGE, notes)
    );

    if (result.kind === 'file_not_found') {
      res.status(404).json({
        ok: false,
        error: 'file_not_found',
        details: `no open-carryforward.md in ${vaultPath} — run Phase 1 migration`,
      });
      return;
    }
    // Decision 029 — delete-on-resolve. `bullet_not_found` covers both
    // "hash was never present" and "already deleted by a prior resolve."
    // Treat as success at the HTTP layer so double-submits and stale UI
    // state don't surface as errors. Still queue the marker so the LLM
    // syncs its in-memory view either way.
    if (result.kind === 'bullet_not_found') {
      const appSessionId = typeof body.app_session_id === 'string' && body.app_session_id
        ? body.app_session_id
        : null;
      const nValue = typeof body.n === 'number' && Number.isFinite(body.n) && body.n > 0
        ? Math.trunc(body.n)
        : null;
      if (appSessionId && nValue !== null) {
        let set = pendingTriageMarkers.get(appSessionId);
        if (!set) {
          set = new Set<number>();
          pendingTriageMarkers.set(appSessionId, set);
        }
        set.add(nValue);
      }
      res.json({ ok: true, action_applied: 'already_gone' });
      return;
    }

    // Successful resolve — queue the marker for the LLM's next turn.
    const appSessionId = typeof body.app_session_id === 'string' && body.app_session_id
      ? body.app_session_id
      : null;
    const nValue = typeof body.n === 'number' && Number.isFinite(body.n) && body.n > 0
      ? Math.trunc(body.n)
      : null;
    if (appSessionId && nValue !== null) {
      let set = pendingTriageMarkers.get(appSessionId);
      if (!set) {
        set = new Set<number>();
        pendingTriageMarkers.set(appSessionId, set);
      }
      set.add(nValue);
    }

    res.json({
      ok: true,
      action_applied: action,
      session_file: result.filePath,  // legacy field name; now the canonical file path
      tagged_at: result.deletedAt,    // legacy field name; semantically "actioned_at"
      by: result.by,
      bullet_preview: result.bulletPreview,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'resolve_failed', details: (err as Error).message });
  }
});

export default router;
