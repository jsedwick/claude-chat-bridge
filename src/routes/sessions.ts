import { Router, Request, Response } from 'express';
import { listSessions, createSession, deleteSession, getSession, getMessages } from '../services/session-store';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json(listSessions());
});

router.post('/', (req: Request, res: Response) => {
  const { name } = req.body || {};
  const session = createSession(name);
  res.status(201).json(session);
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

router.delete('/:id', (req: Request, res: Response) => {
  const deleted = deleteSession(req.params.id as string);
  if (!deleted) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.status(204).end();
});

export default router;
