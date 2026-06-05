import { Router, Request, Response } from 'express';
import { config } from '../config';
import { addSubscription, removeSubscription } from '../services/push-subscriptions';
import { isPushConfigured } from '../services/push-notifier';

const router = Router();

// Client bootstrap: is push available, and what VAPID public key to subscribe with?
router.get('/vapid-key', (_req: Request, res: Response) => {
  res.json({
    configured: isPushConfigured(),
    publicKey: config.vapidPublicKey || null,
  });
});

// Register a browser push subscription (idempotent on endpoint).
router.post('/subscribe', (req: Request, res: Response) => {
  const sub = req.body;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys?.p256dh || !sub.keys?.auth) {
    res.status(400).json({ error: 'Invalid subscription' });
    return;
  }
  addSubscription({
    endpoint: sub.endpoint,
    expirationTime: typeof sub.expirationTime === 'number' ? sub.expirationTime : null,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  });
  res.json({ ok: true });
});

// Drop a subscription (user toggled off, or the browser revoked it).
router.post('/unsubscribe', (req: Request, res: Response) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string') {
    res.status(400).json({ error: 'endpoint required' });
    return;
  }
  removeSubscription(endpoint);
  res.json({ ok: true });
});

export default router;
