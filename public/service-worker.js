// Claude Chat Bridge — Web Push service worker.
//
// The SERVER fires a push whenever a turn completes (or other attention event).
// This worker decides whether to actually surface an OS notification: it
// suppresses it ONLY when you're actively viewing the exact session that
// finished — a focused, visible bridge tab whose open session matches the push.
// Every other case shows it (different session, backgrounded tab, app closed,
// phone locked, no tab open). The page reports its focused session via
// postMessage; this gating runs even when the page's own JS is not — that's the
// whole point of a service worker.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// The page reports which session it's actively viewing (and clears it to null
// when the tab is hidden or blurred). The push handler uses this to suppress
// only the notification for the session you're actually looking at. We rely on
// the page's own visibilitychange/focus events rather than matchAll()'s
// focused/visibilityState, which Safari reports unreliably for background tabs.
let focusedSessionId = null;
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'session-focus') {
    focusedSessionId = msg.sessionId || null;
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    /* malformed payload — fall back to defaults */
  }

  const title = data.title || 'Claude Chat Bridge';
  const options = {
    body: data.body || 'Claude is waiting for you.',
    tag: data.tag || 'claude-chat-bridge',
    renotify: true,
    data: { sessionId: data.sessionId || null, type: data.type || 'turn-complete' },
  };

  event.waitUntil(
    (async () => {
      // Suppress ONLY when the tab you're actively viewing is the one whose
      // turn just finished — you're already looking at it. A focused tab on a
      // different session, a backgrounded tab, or no open tab all still notify.
      // focusedSessionId is maintained by the page (see the 'message' handler
      // above); when it's unknown (SW just restarted, or the page hasn't
      // reported yet) we err toward SHOWING rather than swallowing the alert.
      if (data.sessionId && focusedSessionId && data.sessionId === focusedSessionId) {
        // Cross-check live clients: the page may have been closed while focused
        // (no final 'blurred' report), leaving focusedSessionId stale. Only honor
        // the suppression if a visible bridge window actually still exists —
        // otherwise show, so a closed/hidden tab can never swallow the alert.
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (wins.some((c) => c.visibilityState === 'visible')) return;
      }
      await self.registration.showNotification(title, options);
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetSession = event.notification.data && event.notification.data.sessionId;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if ('focus' in client) {
          await client.focus();
          // Ask the page to open the originating session.
          if (targetSession) client.postMessage({ type: 'open-session', sessionId: targetSession });
          return;
        }
      }
      // No open window — launch one (the page reads ?session= on load if present).
      if (self.clients.openWindow) {
        const url = targetSession ? `/?session=${encodeURIComponent(targetSession)}` : '/';
        await self.clients.openWindow(url);
      }
    })(),
  );
});
