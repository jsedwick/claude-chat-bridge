// Claude Chat Bridge — Web Push service worker.
//
// The SERVER fires a push whenever a turn completes (or other attention event).
// This worker decides whether to actually surface an OS notification: it
// suppresses it when a bridge window is focused+visible (you're already here),
// and shows it otherwise (tab backgrounded, app closed, or phone locked). This
// gating runs even when the page's own JS is not — that's the whole point of a
// service worker.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
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
      // Gate: if a bridge window is focused and visible, the user is already
      // looking — skip the OS notification to avoid a redundant ping.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const anyFocused = windows.some((c) => c.focused && c.visibilityState === 'visible');
      if (anyFocused) return;
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
