import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { listSessions, listSessionsByMode, createSession, deleteSession, getSession, getMessages, updateSession, archiveSession, unarchiveSession, forkSession, getForkPoints, getForkDepth } from '../services/session-store';
import { getMode, setMode, Mode, config, getMcpConfigPath } from '../config';
import { cleanupSessionResources } from '../services/session-reaper';
import { getActiveAppSessionIds } from '../services/claude-runner';

const router = Router();

// Read allowed paths from MCP settings config
function getAllowedPaths(): string[] {
  try {
    const raw = fs.readFileSync(getMcpConfigPath(), 'utf-8');
    const data = JSON.parse(raw);
    const paths: string[] = data?.security?.accessControl?.allowedPaths || [];
    const home = os.homedir();
    return paths.map(p =>
      p.startsWith('~/') || p === '~' ? home + p.slice(1) : p
    );
  } catch {
    return [];
  }
}

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
  if (mode === 'work' || mode === 'personal') {
    res.json(listSessionsByMode(mode, includeArchived));
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
  res.status(201).json(session);
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

router.post('/:id/fork', (req: Request, res: Response) => {
  const { messageIndex } = req.body || {};
  if (typeof messageIndex !== 'number' || messageIndex < 0) {
    res.status(400).json({ error: 'messageIndex is required and must be a non-negative number' });
    return;
  }
  const forked = forkSession(req.params.id as string, messageIndex);
  if (forked === 'max_depth') {
    res.status(400).json({ error: 'Maximum fork depth reached (2 levels)' });
    return;
  }
  if (!forked) {
    res.status(404).json({ error: 'Session not found or invalid message index' });
    return;
  }
  res.status(201).json(forked);
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
  cleanupSessionResources(req.params.id as string);
  const deleted = deleteSession(req.params.id as string);
  if (!deleted) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.status(204).end();
});

export default router;
