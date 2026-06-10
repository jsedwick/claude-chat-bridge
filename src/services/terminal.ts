import http from 'http';
import https from 'https';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import type { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import { shellExecOpts } from './shell-env';

// Integrated terminal backend (Decision 004, Phase 1). A WebSocket upgrade on
// TERMINAL_PATH is bridged to a node-pty PTY running an interactive login shell
// that execs into tmux (attach-or-create), so sessions persist across reconnects
// — the same persistence the standalone ttyd+tmux spike validated, but hosted in
// the bridge so the frontend owns rendering, sizing, and (later) the session list.

const TMUX = '/opt/homebrew/bin/tmux';
const TERMINAL_PATH = '/api/terminal';

// Some node-pty prebuild tarballs ship the macOS spawn-helper without its execute
// bit, which makes posix_spawnp fail at runtime. The package.json postinstall fixes
// this on install; this is a belt-and-suspenders guard for fresh checkouts that
// skipped scripts.
function ensureSpawnHelperExecutable(): void {
  try {
    const libDir = path.dirname(require.resolve('node-pty'));
    for (const arch of ['darwin-arm64', 'darwin-x64']) {
      const helper = path.join(libDir, '..', 'prebuilds', arch, 'spawn-helper');
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
    }
  } catch {
    /* best-effort */
  }
}

// tmux session names are interpolated into the spawn command, so restrict to a
// safe charset and bound the length.
function sanitizeSession(name: string | null): string {
  const cleaned = (name || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return cleaned || 'claude';
}

// Browsers do NOT enforce same-origin on WebSocket connections, so a malicious
// page could otherwise open a shell over the user's tailnet (cross-site WS
// hijacking). Require the Origin host to match the Host header; non-browser
// clients (no Origin) are allowed since they can't be a CSWSH vector.
function originAllowed(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// With tmux mouse on, a drag-selection is copied by tmux into its own paste
// buffer (copy-selection-and-cancel on drag end) — it never reaches the
// browser's clipboard. The frontend Copy button falls back to fetching the
// most recent tmux buffer through this endpoint.
export function terminalClipboard(_req: Request, res: Response): void {
  execFile(TMUX, ['show-buffer'], { maxBuffer: 1024 * 1024 }, (err, stdout) => {
    if (err) {
      res.status(204).end(); // no buffer yet (or no tmux server) — nothing to copy
      return;
    }
    res.type('text/plain').send(stdout);
  });
}

export function attachTerminal(server: http.Server | https.Server): void {
  ensureSpawnHelperExecutable();
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url || '', `http://${req.headers.host}`);
    } catch {
      return;
    }
    if (url.pathname !== TERMINAL_PATH) return; // not ours — leave for other upgrade handlers
    if (!originAllowed(req)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      startSession(ws, sanitizeSession(url.searchParams.get('session')));
    });
  });

  console.log(`[terminal] WebSocket terminal attached at ${TERMINAL_PATH}`);
}

function startSession(ws: WebSocket, session: string): void {
  const shell = process.env.SHELL || '/bin/zsh';
  const opts = shellExecOpts({
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.env.HOME,
  });

  // Login shell (-l) so rc files rebuild the full PATH (incl. ~/.local/bin for
  // `claude`) under launchd's minimal env; exec tmux so closing tmux ends the PTY.
  // mouse on (session-scoped via command chain, not -g) lets wheel/touch scroll
  // reach tmux's scrollback — without it the alternate screen swallows scrolling.
  const term = pty.spawn(shell, ['-lc', `exec ${TMUX} new -A -s ${session} \\; set-option mouse on`], opts as pty.IPtyForkOptions);

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  term.onExit(() => {
    if (ws.readyState === ws.OPEN) ws.close();
  });

  ws.on('message', (raw) => {
    let msg: { type?: string; data?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'data' && typeof msg.data === 'string') {
      term.write(msg.data);
    } else if (
      msg.type === 'resize' &&
      Number.isInteger(msg.cols) &&
      Number.isInteger(msg.rows)
    ) {
      try {
        term.resize(msg.cols as number, msg.rows as number);
      } catch {
        /* ignore transient resize errors */
      }
    }
  });

  ws.on('close', () => {
    // Kill the PTY (the tmux *client*); the tmux server + session persist detached
    // so the next connection re-attaches via `new -A`.
    try {
      term.kill();
    } catch {
      /* already gone */
    }
  });
}
