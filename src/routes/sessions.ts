import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { listSessions, listSessionsByMode, createSession, deleteSession, getSession, getMessages, updateSession, archiveSession, unarchiveSession } from '../services/session-store';
import { getMode, setMode, Mode, config } from '../config';
import { cleanupSessionResources } from '../services/session-reaper';
import { getActiveAppSessionIds } from '../services/claude-runner';

const router = Router();

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
  const { name, workingDir } = req.body || {};
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
  const session = createSession(name, workingDir || undefined);
  res.status(201).json(session);
});

// Available working directories (dynamically scanned)
router.get('/dirs/available', (_req: Request, res: Response) => {
  const dirs: Array<{ path: string; label: string }> = [
    { path: config.workingDir, label: 'Home (default)' },
  ];

  for (const scanDir of config.projectScanDirs) {
    try {
      const entries = fs.readdirSync(scanDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          dirs.push({
            path: path.join(scanDir, entry.name),
            label: entry.name,
          });
        }
      }
    } catch {}
  }

  // Sort projects alphabetically (after Home)
  const [home, ...projects] = dirs;
  projects.sort((a, b) => a.label.localeCompare(b.label));
  res.json([home, ...projects]);
});

// Browse directories for the directory picker
router.get('/dirs/browse', (req: Request, res: Response) => {
  const dirPath = (req.query.path as string) || config.workingDir;
  const resolved = path.resolve(dirPath);

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
        children.push({
          name: entry.name,
          path: path.join(resolved, entry.name),
        });
      }
    }
  } catch {
    // Permission denied or other read error — return empty children
  }

  children.sort((a, b) => a.name.localeCompare(b.name));
  res.json({
    path: resolved,
    parent: path.dirname(resolved) !== resolved ? path.dirname(resolved) : null,
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
  res.json(session);
});

router.get('/:id/messages', (req: Request, res: Response) => {
  const messages = getMessages(req.params.id as string);
  res.json(messages);
});

router.patch('/:id', (req: Request, res: Response) => {
  const { name, workingDir } = req.body || {};
  const updates: Record<string, unknown> = {};
  if (name && typeof name === 'string') updates.name = name.trim();
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
