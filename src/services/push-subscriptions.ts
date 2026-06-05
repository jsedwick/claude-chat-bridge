import fs from 'fs';
import { config } from '../config';

// One browser push subscription — the shape produced by PushManager.subscribe().
export interface StoredPushSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

let subscriptions: StoredPushSubscription[] = [];

function load(): void {
  try {
    subscriptions = JSON.parse(fs.readFileSync(config.pushStorePath, 'utf-8'));
  } catch {
    subscriptions = [];
  }
}

function save(): void {
  // temp + rename so a crash mid-write can't corrupt the store (matches session-store).
  const tmp = `${config.pushStorePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(subscriptions, null, 2));
  fs.renameSync(tmp, config.pushStorePath);
}

load();

export function listSubscriptions(): StoredPushSubscription[] {
  return [...subscriptions];
}

// Idempotent on endpoint — re-subscribing the same browser is a no-op.
export function addSubscription(sub: StoredPushSubscription): void {
  if (subscriptions.some((s) => s.endpoint === sub.endpoint)) return;
  subscriptions.push(sub);
  save();
}

export function removeSubscription(endpoint: string): void {
  const before = subscriptions.length;
  subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint);
  if (subscriptions.length !== before) save();
}
