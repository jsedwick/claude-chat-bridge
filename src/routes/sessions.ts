import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { listSessions, listSessionsByMode, createSession, deleteSession, getSession, getMessages, updateSession, archiveSession, unarchiveSession } from '../services/session-store';
import { getMode, setMode, Mode, config } from '../config';

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
  // Validate workingDir — must be home, a scan dir, or a direct child of a scan dir
  if (workingDir) {
    const isHome = workingDir === config.workingDir;
    const isScanDir = config.projectScanDirs.includes(workingDir);
    const isChildOfScanDir = config.projectScanDirs.some(d =>
      workingDir.startsWith(d + '/') && !workingDir.substring(d.length + 1).includes('/')
    );
    if (!isHome && !isScanDir && !isChildOfScanDir) {
      res.status(400).json({ error: 'Invalid working directory' });
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
      const isHome = workingDir === config.workingDir;
      const isScanDir = config.projectScanDirs.includes(workingDir);
      const isChildOfScanDir = config.projectScanDirs.some((d: string) =>
        workingDir.startsWith(d + '/') && !workingDir.substring(d.length + 1).includes('/')
      );
      if (!isHome && !isScanDir && !isChildOfScanDir) {
        res.status(400).json({ error: 'Invalid working directory' });
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
  const deleted = deleteSession(req.params.id as string);
  if (!deleted) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.status(204).end();
});

export default router;
