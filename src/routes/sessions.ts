import { Router, Request, Response } from 'express';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { listSessions, listSessionsByMode, listTrashedSessionsByMode, createSession, deleteSession, getSession, getMessages, updateSession, archiveSession, unarchiveSession, trashSession, restoreSession, forkSession, getForkPoints, getForkDepth } from '../services/session-store';
import { getMode, setMode, Mode, config, getAllowedPaths, getActiveModeVaults } from '../config';
import { cleanupSessionResources } from '../services/session-reaper';
import { getActiveAppSessionIds } from '../services/claude-runner';
import { isDirectoryTrusted } from '../services/permissions';

const router = Router();

// Check if a path is within any of the allowed paths
function isWithinAllowedPaths(targetPath: string, allowedPaths: string[]): boolean {
  const resolved = path.resolve(targetPath);
  return allowedPaths.some(ap => {
    const resolvedAp = path.resolve(ap);
    return resolved === resolvedAp || resolved.startsWith(resolvedAp + path.sep);
  });
}

router.get('/', (req: Request, res: Response) => {
  const mode = req.query.mode as string | undefined;
  const includeArchived = req.query.archived === 'true';
  const trashedOnly = req.query.trashed === 'true';
  if (mode === 'work' || mode === 'personal') {
    if (trashedOnly) {
      res.json(listTrashedSessionsByMode(mode));
    } else {
      res.json(listSessionsByMode(mode, includeArchived));
    }
  } else {
    res.json(listSessions());
  }
});

router.post('/', (req: Request, res: Response) => {
  const { name, workingDir, model } = req.body || {};
  // Validate workingDir — must be an existing directory
  if (workingDir) {
    try {
      const stat = fs.statSync(path.resolve(workingDir));
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'Not a directory' });
        return;
      }
    } catch {
      res.status(400).json({ error: 'Directory not found' });
      return;
    }
  }
  const session = createSession(name, workingDir || undefined, model || undefined);
  const trusted = workingDir ? isDirectoryTrusted(workingDir) : true;
  res.status(201).json({ ...session, directoryTrusted: trusted });
});

// Allowed root directories for the directory picker
router.get('/dirs/roots', (_req: Request, res: Response) => {
  const allowedPaths = getAllowedPaths();
  const roots = allowedPaths.map(p => ({
    name: path.basename(p),
    path: path.resolve(p),
  }));
  roots.sort((a, b) => a.name.localeCompare(b.name));
  res.json(roots);
});

// Browse directories for the directory picker (restricted to allowed paths)
router.get('/dirs/browse', (req: Request, res: Response) => {
  const dirPath = (req.query.path as string) || config.workingDir;
  const resolved = path.resolve(dirPath);
  const unrestricted = req.query.unrestricted === '1';

  // Enforce allowed paths restriction (unless unrestricted mode for settings)
  const allowedPaths = getAllowedPaths();
  const enforce = !unrestricted && allowedPaths.length > 0;

  if (enforce && !isWithinAllowedPaths(resolved, allowedPaths)) {
    res.status(403).json({ error: 'Directory is outside allowed paths' });
    return;
  }

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: 'Not a directory' });
      return;
    }
  } catch {
    res.status(404).json({ error: 'Directory not found' });
    return;
  }

  const children: Array<{ name: string; path: string }> = [];
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const childPath = path.join(resolved, entry.name);
        if (!enforce || isWithinAllowedPaths(childPath, allowedPaths)) {
          children.push({
            name: entry.name,
            path: childPath,
          });
        }
      }
    }
  } catch {
    // Permission denied or other read error — return empty children
  }

  children.sort((a, b) => a.name.localeCompare(b.name));

  // Only allow navigating up if the parent is still within allowed paths
  const parentDir = path.dirname(resolved);
  const hasParent = parentDir !== resolved &&
    (!enforce || isWithinAllowedPaths(parentDir, allowedPaths));

  res.json({
    path: resolved,
    parent: hasParent ? parentDir : null,
    children,
  });
});

// In-memory file index for @-mention autocomplete. Keyed by the joined source paths
// so that a mode switch (which changes vault roots) naturally invalidates.
interface IndexEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  vault?: string;
  mtimeMs: number;
}
interface CachedIndex {
  entries: IndexEntry[];
  builtAt: number;
}
const indexCache = new Map<string, CachedIndex>();
const INDEX_TTL_MS = 30_000;
const SKIP_DIRS = new Set(['.git', '.obsidian', 'node_modules', 'dist', '.next', '.cache', '.trash', '.DS_Store']);
const MAX_DEPTH = 6;
const MAX_INDEX_ENTRIES = 50_000;

function buildIndex(roots: Array<{ name?: string; path: string }>): IndexEntry[] {
  const entries: IndexEntry[] = [];
  function walk(dir: string, depth: number, vault?: string) {
    if (depth > MAX_DEPTH || entries.length >= MAX_INDEX_ENTRIES) return;
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of children) {
      if (entries.length >= MAX_INDEX_ENTRIES) return;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const childPath = path.join(dir, e.name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(childPath).mtimeMs;
      } catch {
        // stat can fail on broken symlinks or permission errors; treat as oldest
      }
      entries.push({ name: e.name, path: childPath, isDirectory: e.isDirectory(), vault, mtimeMs });
      if (e.isDirectory()) walk(childPath, depth + 1, vault);
    }
  }
  for (const root of roots) {
    walk(root.path, 0, root.name);
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

function getOrBuildIndex(cacheKey: string, roots: Array<{ name?: string; path: string }>): IndexEntry[] {
  const cached = indexCache.get(cacheKey);
  if (cached && Date.now() - cached.builtAt < INDEX_TTL_MS) return cached.entries;
  const entries = buildIndex(roots);
  indexCache.set(cacheKey, { entries, builtAt: Date.now() });
  return entries;
}

function rankMatches(entries: IndexEntry[], query: string, limit: number): IndexEntry[] {
  if (!query) return entries.slice(0, limit);
  const q = query.toLowerCase();
  const exact: IndexEntry[] = [];
  const prefix: IndexEntry[] = [];
  const substring: IndexEntry[] = [];
  for (const e of entries) {
    const name = e.name.toLowerCase();
    if (name === q) exact.push(e);
    else if (name.startsWith(q)) prefix.push(e);
    else if (name.includes(q)) substring.push(e);
    if (exact.length + prefix.length + substring.length >= limit * 4) break;
  }
  return [...exact, ...prefix, ...substring].slice(0, limit);
}

// Filter an index to entries strictly *under* a scope directory (not the scope itself).
// Returns null when the scope is not inside any allowed root (so the caller can 403).
function filterEntriesByScope(
  entries: IndexEntry[],
  scope: string,
  allowedRoots: string[],
): IndexEntry[] | null {
  const resolved = path.resolve(scope);
  if (!isWithinAllowedPaths(resolved, allowedRoots)) return null;
  const prefix = resolved + path.sep;
  return entries.filter(e => e.path.startsWith(prefix));
}

// Search files/directories under allowed paths for @-mention autocomplete.
// Optional `scope=<abs-path>` narrows the search to descendants of that directory
// (must itself be within an allowed path, else 403).
router.get('/dirs/search', (req: Request, res: Response) => {
  const q = (req.query.q as string) || '';
  const limit = Math.min(parseInt((req.query.limit as string) || '20', 10) || 20, 100);
  const scope = (req.query.scope as string) || '';
  const allowed = getAllowedPaths();
  if (allowed.length === 0) {
    res.json([]);
    return;
  }
  const cacheKey = 'dirs:' + allowed.join('|');
  let entries = getOrBuildIndex(cacheKey, allowed.map(p => ({ path: p })));
  if (scope) {
    const scoped = filterEntriesByScope(entries, scope, allowed);
    if (scoped === null) {
      res.status(403).json({ error: 'Scope outside allowed paths' });
      return;
    }
    entries = scoped;
  }
  res.json(rankMatches(entries, q, limit).map(e => ({
    name: e.name,
    path: e.path,
    isDirectory: e.isDirectory,
  })));
});

// Search files/directories across all vaults of the current mode for @vault: autocomplete.
// Optional `scope=<abs-path>` narrows to descendants of a directory under one of those vaults.
router.get('/dirs/vault-search', (req: Request, res: Response) => {
  const q = (req.query.q as string) || '';
  const limit = Math.min(parseInt((req.query.limit as string) || '20', 10) || 20, 100);
  const scope = (req.query.scope as string) || '';
  const vaults = getActiveModeVaults(getMode());
  if (vaults.length === 0) {
    res.json([]);
    return;
  }
  const cacheKey = 'vault:' + getMode() + ':' + vaults.map(v => v.path).join('|');
  let entries = getOrBuildIndex(cacheKey, vaults);
  if (scope) {
    const scoped = filterEntriesByScope(entries, scope, vaults.map(v => v.path));
    if (scoped === null) {
      res.status(403).json({ error: 'Scope outside active-mode vaults' });
      return;
    }
    entries = scoped;
  }
  res.json(rankMatches(entries, q, limit).map(e => ({
    name: e.name,
    path: e.path,
    isDirectory: e.isDirectory,
    vault: e.vault,
  })));
});

// Active sessions endpoint (must be before /:id to avoid param capture)
router.get('/active', (_req: Request, res: Response) => {
  res.json(getActiveAppSessionIds());
});

// Mode endpoints (must be before /:id to avoid param capture)
router.get('/mode/current', (_req: Request, res: Response) => {
  res.json({ mode: getMode() });
});

router.post('/mode/current', (req: Request, res: Response) => {
  const { mode } = req.body || {};
  if (mode !== 'work' && mode !== 'personal') {
    res.status(400).json({ error: 'Mode must be "work" or "personal"' });
    return;
  }
  setMode(mode as Mode);
  res.json({ mode: getMode() });
});

// Get git diff for a file since a session started
router.get('/:id/file-diff', (req: Request, res: Response) => {
  const session = getSession(req.params.id as string);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const filePath = req.query.path as string;
  if (!filePath) {
    res.status(400).json({ error: 'path query parameter required' });
    return;
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    res.json({ diff: null, message: 'File not found' });
    return;
  }

  // Find the git repo root for this file
  let repoDir: string;
  try {
    repoDir = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: path.dirname(resolved),
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    res.json({ diff: null, message: 'Not a git repository' });
    return;
  }

  const relativePath = path.relative(repoDir, resolved);
  const sessionCreated = session.created;

  try {
    // Find the last commit before the session started (any commit, not file-specific)
    const beforeCommit = execFileSync('git', [
      'log', '--before=' + sessionCreated, '-1', '--format=%H',
    ], { cwd: repoDir, encoding: 'utf-8', timeout: 5000 }).trim();

    let diff: string;
    if (beforeCommit) {
      // Diff from pre-session state to working tree (includes uncommitted changes)
      diff = execFileSync('git', [
        'diff', beforeCommit, '--', relativePath,
      ], { cwd: repoDir, encoding: 'utf-8', timeout: 10000 }).trim();
    } else {
      // No commits before session — diff working tree against empty tree
      diff = execFileSync('git', [
        'diff', '4b825dc642cb6eb9a060e54bf899d15363d7aa16', '--', relativePath,
      ], { cwd: repoDir, encoding: 'utf-8', timeout: 10000 }).trim();
    }

    if (!diff) {
      res.json({ diff: null, message: 'No changes during this session' });
      return;
    }

    res.json({ diff, path: resolved });
  } catch {
    res.json({ diff: null, message: 'Failed to retrieve git diff' });
  }
});

// Get handoff notes for a closed session
router.get('/:id/handoff', (req: Request, res: Response) => {
  const session = getSession(req.params.id as string);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (!session.closedAt) {
    res.json({ handoff: null, message: 'Session is not closed' });
    return;
  }

  // Return stored handoff if available
  if (session.handoff) {
    res.json({ handoff: session.handoff });
    return;
  }

  // Fallback: try to read from vault session file
  if (session.sessionFilePath) {
    try {
      const content = fs.readFileSync(session.sessionFilePath, 'utf-8');
      const match = content.match(/## Handoff\n\n([\s\S]*?)(?=\n## |\n---|$)/);
      if (match && match[1].trim() && match[1].trim() !== '_No handoff notes_') {
        const handoff = match[1].trim();
        // Cache it on the session for next time
        updateSession(req.params.id as string, { handoff });
        res.json({ handoff });
        return;
      }
    } catch {}
  }

  // Last resort: scan messages for close_session finalize tool call
  const messages = getMessages(req.params.id as string);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'tool') continue;
    try {
      const tool = JSON.parse(messages[i].content);
      if (tool.name?.includes('close_session') && tool.input?.finalize && tool.input?.handoff) {
        const handoff = tool.input.handoff;
        updateSession(req.params.id as string, { handoff, sessionFilePath: tool.input?.session_data?.sessionFile });
        res.json({ handoff });
        return;
      }
    } catch {}
  }

  res.json({ handoff: null, message: 'No handoff notes found' });
});

// Update handoff notes for a closed session
router.put('/:id/handoff', (req: Request, res: Response) => {
  const session = getSession(req.params.id as string);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (!session.closedAt) {
    res.status(400).json({ error: 'Session is not closed' });
    return;
  }

  const { handoff } = req.body || {};
  if (typeof handoff !== 'string') {
    res.status(400).json({ error: 'handoff string required' });
    return;
  }

  // Update session store
  updateSession(req.params.id as string, { handoff });

  // Also update the vault session file if we know its path
  const filePath = session.sessionFilePath;
  if (filePath && fs.existsSync(filePath)) {
    try {
      let content = fs.readFileSync(filePath, 'utf-8');
      // Replace the ## Handoff section content
      const handoffRegex = /(## Handoff\n\n)([\s\S]*?)(\n## )/;
      const match = content.match(handoffRegex);
      if (match) {
        content = content.replace(handoffRegex, (_m, g1, _g2, g3) => `${g1}${handoff}\n${g3}`);
        fs.writeFileSync(filePath, content, 'utf-8');
      }
    } catch {}
  }

  res.json({ handoff });
});

router.post('/:id/fork', (req: Request, res: Response) => {
  const { messageIndex, workingDir } = req.body || {};
  if (typeof messageIndex !== 'number' || messageIndex < 0) {
    res.status(400).json({ error: 'messageIndex is required and must be a non-negative number' });
    return;
  }
  if (workingDir !== undefined && workingDir !== null) {
    if (typeof workingDir !== 'string' || !workingDir) {
      res.status(400).json({ error: 'workingDir must be a non-empty string' });
      return;
    }
    try {
      const stat = fs.statSync(path.resolve(workingDir));
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'Not a directory' });
        return;
      }
    } catch {
      res.status(400).json({ error: 'Directory not found' });
      return;
    }
  }
  const forked = forkSession(
    req.params.id as string,
    messageIndex,
    typeof workingDir === 'string' ? workingDir : undefined,
  );
  if (forked === 'max_depth') {
    res.status(400).json({ error: 'Maximum fork depth reached (5 levels)' });
    return;
  }
  if (!forked) {
    res.status(404).json({ error: 'Session not found or invalid message index' });
    return;
  }
  const trusted = forked.workingDir ? isDirectoryTrusted(forked.workingDir) : true;
  res.status(201).json({ ...forked, directoryTrusted: trusted });
});

router.get('/:id/forks', (req: Request, res: Response) => {
  const session = getSession(req.params.id as string);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(getForkPoints(req.params.id as string));
});

router.post('/:id/archive', (req: Request, res: Response) => {
  const session = archiveSession(req.params.id as string);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  cleanupSessionResources(req.params.id as string);
  res.json(session);
});

router.post('/:id/unarchive', (req: Request, res: Response) => {
  const session = unarchiveSession(req.params.id as string);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(session);
});

router.post('/:id/trash', (req: Request, res: Response) => {
  cleanupSessionResources(req.params.id as string);
  const { session, evicted } = trashSession(req.params.id as string);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  // Clean up resources for any sessions evicted by the FIFO cap
  for (const evictedId of evicted) {
    cleanupSessionResources(evictedId);
  }
  res.json(session);
});

router.post('/:id/restore', (req: Request, res: Response) => {
  const session = restoreSession(req.params.id as string);
  if (!session) {
    res.status(404).json({ error: 'Session not found or not in trash' });
    return;
  }
  res.json(session);
});

router.get('/:id', (req: Request, res: Response) => {
  const session = getSession(req.params.id as string);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ ...session, forkDepth: getForkDepth(session.id) });
});

router.get('/:id/messages', (req: Request, res: Response) => {
  const messages = getMessages(req.params.id as string);
  res.json(messages);
});

router.patch('/:id', (req: Request, res: Response) => {
  const { name, workingDir, model } = req.body || {};
  const updates: Record<string, unknown> = {};
  if (name && typeof name === 'string') updates.name = name.trim();
  if (model && typeof model === 'string') updates.model = model;
  if (workingDir !== undefined) {
    if (workingDir) {
      try {
        const stat = fs.statSync(path.resolve(workingDir));
        if (!stat.isDirectory()) {
          res.status(400).json({ error: 'Not a directory' });
          return;
        }
      } catch {
        res.status(400).json({ error: 'Directory not found' });
        return;
      }
    }
    updates.workingDir = workingDir || undefined;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No valid fields to update' });
    return;
  }
  const session = updateSession(req.params.id as string, updates);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(session);
});

router.delete('/:id', (req: Request, res: Response) => {
  const permanent = req.query.permanent === 'true';
  if (permanent) {
    // Permanent delete (from trash)
    cleanupSessionResources(req.params.id as string);
    const deleted = deleteSession(req.params.id as string);
    if (!deleted) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.status(204).end();
  } else {
    // Soft delete — move to trash
    cleanupSessionResources(req.params.id as string);
    const { session, evicted } = trashSession(req.params.id as string);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    for (const evictedId of evicted) {
      cleanupSessionResources(evictedId);
    }
    res.json(session);
  }
});

export default router;
