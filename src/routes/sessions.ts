import { Router, Request, Response } from 'express';
import { listSessions, listSessionsByMode, createSession, deleteSession, getSession, getMessages, updateSession } from '../services/session-store';
import { getMode, setMode, Mode, config } from '../config';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const mode = req.query.mode as string | undefined;
  if (mode === 'work' || mode === 'personal') {
    res.json(listSessionsByMode(mode));
  } else {
    res.json(listSessions());
  }
});

router.post('/', (req: Request, res: Response) => {
  const { name, workingDir } = req.body || {};
  // Validate workingDir against allowed list
  if (workingDir && !config.workingDirs.some(d => d.path === workingDir)) {
    res.status(400).json({ error: 'Invalid working directory' });
    return;
  }
  const session = createSession(name, workingDir || undefined);
  res.status(201).json(session);
});

// Available working directories
router.get('/dirs/available', (_req: Request, res: Response) => {
  res.json(config.workingDirs);
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
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'Name is required' });
    return;
  }
  const session = updateSession(req.params.id as string, { name: name.trim() });
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
