import webpush from 'web-push';
import { config } from '../config';
import { listSubscriptions, removeSubscription } from './push-subscriptions';

let configured = false;

export function isPushConfigured(): boolean {
  return !!(config.vapidPublicKey && config.vapidPrivateKey);
}

// Lazy: only wire VAPID details on first send, so a bridge with no keys
// configured starts fine and the push endpoints simply report "unconfigured".
function ensureConfigured(): boolean {
  if (configured) return true;
  if (!isPushConfigured()) return false;
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
  configured = true;
  return true;
}

export interface PushPayload {
  title: string;
  body: string;
  sessionId?: string;
  type?: string;
  tag?: string;
}

// Send a push to every registered browser. Callers fire-and-forget — failures
// are logged, and subscriptions the push service rejects as gone (404/410) are
// pruned so the store self-heals.
export async function sendPush(payload: PushPayload): Promise<void> {
  if (!ensureConfigured()) return;
  const subs = listSubscriptions();
  if (subs.length === 0) return;

  const data = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub as any, data);
      } catch (err: any) {
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          removeSubscription(sub.endpoint);
        } else {
          console.log(`[push] send failed status=${status} ${err?.body || err?.message || err}`);
        }
      }
    }),
  );
}

// Turn-complete: the claude -p turn finished, so the bridge is now waiting for
// the user. The service worker decides whether to actually surface this — it
// suppresses the OS notification when a bridge window is focused.
export async function notifyTurnComplete(
  sessionName: string,
  sessionId: string,
  isError: boolean,
): Promise<void> {
  const name = (sessionName || '').trim();
  const title = isError
    ? name
      ? `${name} — needs attention`
      : 'Needs attention'
    : name || 'Claude Chat Bridge';
  const body = isError
    ? 'The last turn ended with an error — open the bridge to continue.'
    : 'Claude finished responding — your turn.';
  await sendPush({ title, body, sessionId, type: 'turn-complete', tag: `turn-${sessionId}` });
}
