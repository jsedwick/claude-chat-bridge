import http from 'http';
import https from 'https';
import path from 'path';
import fs from 'fs';
import { execFile, execFileSync } from 'child_process';
import type { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import { shellExecOpts } from './shell-env';
import { getActiveModeVaults, parseMode } from '../config';
import { scheduleTerminalSnapshot, pruneTerminalSnapshot } from './terminal-snapshot';

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

// The session name is interpolated into the startSession shell command (the
// `-lc` tmux exec), so the charset stays conservative: letters, digits,
// spaces, underscore, hyphen, comma — no shell metacharacters, no ':' (it's
// the delimiter of the list-sessions output format), and NO '.': tmux's
// session_check_name silently rewrites '.' and ':' to '_' at creation, so a
// dotted name never round-trips (the stored name differs from the requested
// one and every name-keyed lookup desyncs into phantom duplicates), and a '.'
// inside any '-t' target parses as tmux's window.pane separator — even
// operations addressed AT a dotted name fail ("can't find pane", the
// 2026-06-11 rename-409 storm). Comma is verified to survive both creation
// and target parsing. Spaces ARE allowed (tmux accepts them and the list
// format splits on ':', so they survive); the shell command single-quotes the
// name to keep them from word-splitting. Whitespace runs collapse to a single
// space and the ends are trimmed so the frontend's optimistic tab label
// matches what tmux ends up storing.
function sanitizeSession(name: string | null): string {
  const cleaned = (name || '').replace(/[^a-zA-Z0-9 _,-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
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

// Terminal session tabs (sidebar parity with the chat session list). tmux is
// the source of truth: list live sessions, and kill on tab close. Creation
// needs no endpoint — connecting the WS with ?session=<name> attaches-or-creates.
export function terminalSessions(_req: Request, res: Response): void {
  // Colon separator: tmux forbids ':' in session names, and (unlike tab) it
  // survives tmux's format-output sanitization, which replaces control chars
  // with '_' — tabs here silently merged all three fields into one string.
  // The cwd rides last because paths MAY contain colons: the first six
  // fields are colon-free (sanitized name, numeric timestamps, validated
  // mode, flag bits), so everything past them is rejoined as the path.
  // #{pane_current_path} resolves to each session's active pane;
  // #{@bridge_mode} is the context tag set by terminalSessionMode, and the
  // archived/trashed bits are the sidebar lifecycle flags (all empty for
  // untagged sessions).
  execFile(
    TMUX,
    ['list-sessions', '-F', '#{session_name}:#{session_created}:#{session_attached}:#{@bridge_mode}:#{@bridge_archived}:#{@bridge_trashed}:#{pane_current_path}'],
    (err, stdout) => {
      if (err) {
        res.json([]); // no tmux server running — no sessions yet
        return;
      }
      const sessions = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(':');
          const [name, created, attached, mode, archived, trashed] = parts;
          return { name, created: Number(created) * 1000, attached: attached !== '0', mode: mode || '', archived: archived === '1', trashed: trashed === '1', path: parts.slice(6).join(':') };
        });
      res.json(sessions);
    }
  );
}

export function terminalRenameSession(req: Request, res: Response): void {
  const oldName = sanitizeSession(String(req.params.name || ''));
  const newName = sanitizeSession(String((req.body || {}).name || ''));
  if (!newName) {
    res.status(400).json({ error: 'invalid session name' });
    return;
  }
  execFile(TMUX, ['rename-session', '-t', oldName, newName], (err) => {
    if (err) {
      res.status(409).json({ error: 'rename failed — duplicate or missing session' });
      return;
    }
    scheduleTerminalSnapshot();
    res.json({ name: newName });
  });
}

// Tag a session with its bridge context mode. Stored as a tmux user option so
// the tag lives with the session itself — visible from any browser, gone when
// the session is killed.
export function terminalSessionMode(req: Request, res: Response): void {
  const name = sanitizeSession(String(req.params.name || ''));
  const mode = String((req.body || {}).mode || '');
  if (mode !== 'work' && mode !== 'personal') {
    res.status(400).json({ error: 'mode must be "work" or "personal"' });
    return;
  }
  execFile(TMUX, ['set-option', '-t', name, '@bridge_mode', mode], (err) => {
    if (err) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    scheduleTerminalSnapshot();
    res.json({ name, mode });
  });
}

// Archive/trash lifecycle for the sidebar (parity with the chat session
// list). Each flag is a tmux user option riding on the session — the same
// pattern as @bridge_mode — so it survives bridge restarts and dies with the
// session. An archived or trashed session keeps running; only the trash
// row's permanent delete (the DELETE route → kill-session) terminates it.
// Trash clears the archive flag so a session sits in exactly one bucket;
// -u -q unsets quietly even when the option was never set — and also when
// the session is gone, so the unset-only routes (unarchive/restore) are
// idempotent successes rather than 404s; only the set paths report a missing
// session. The lone ';' arg is tmux's command separator (no shell involved,
// so no escaping).
function setLifecycleFlags(name: string, args: string[], res: Response): void {
  execFile(TMUX, args, (err) => {
    if (err) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    scheduleTerminalSnapshot();
    res.json({ name });
  });
}

export function terminalArchiveSession(req: Request, res: Response): void {
  const name = sanitizeSession(String(req.params.name || ''));
  setLifecycleFlags(name, ['set-option', '-t', name, '@bridge_archived', '1', ';', 'set-option', '-u', '-q', '-t', name, '@bridge_trashed'], res);
}

export function terminalUnarchiveSession(req: Request, res: Response): void {
  const name = sanitizeSession(String(req.params.name || ''));
  setLifecycleFlags(name, ['set-option', '-u', '-q', '-t', name, '@bridge_archived'], res);
}

export function terminalTrashSession(req: Request, res: Response): void {
  const name = sanitizeSession(String(req.params.name || ''));
  setLifecycleFlags(name, ['set-option', '-t', name, '@bridge_trashed', '1', ';', 'set-option', '-u', '-q', '-t', name, '@bridge_archived'], res);
}

export function terminalRestoreSession(req: Request, res: Response): void {
  const name = sanitizeSession(String(req.params.name || ''));
  setLifecycleFlags(name, ['set-option', '-u', '-q', '-t', name, '@bridge_trashed'], res);
}

// Session metadata for the details panel. Two queries: colon-joined safe
// fields first (numbers + command name), then the cwd alone on its own line —
// paths may contain colons, so it can't ride in the joined format.
export function terminalSessionDetails(req: Request, res: Response): void {
  const name = sanitizeSession(String(req.params.name || ''));
  execFile(
    TMUX,
    ['display-message', '-p', '-t', name,
      '#{session_created}:#{session_attached}:#{session_windows}:#{window_panes}:#{pane_width}x#{pane_height}:#{pane_current_command}'],
    (err, stdout) => {
      if (err) {
        res.status(404).json({ error: 'session not found' });
        return;
      }
      const [created, attached, windows, panes, size, ...cmd] = stdout.trim().split(':');
      execFile(TMUX, ['display-message', '-p', '-t', name, '#{pane_current_path}'], (err2, pathOut) => {
        res.json({
          name,
          created: Number(created) * 1000,
          attached: attached !== '0',
          windows: Number(windows),
          panes: Number(panes),
          size,
          command: cmd.join(':'),
          path: err2 ? '' : pathOut.trim(),
        });
      });
    }
  );
}

// Git's well-known empty-tree hash — the diff baseline when a repo has no
// commit predating the session (same fallback as the chat file-diff route).
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf899d15363d7aa16';

function gitRepoRoot(dir: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

// Files changed in a repo since the session started: tracked files are diffed
// against the last commit before session creation (so work committed
// mid-session still shows), plus untracked files born after the session began
// (mtime filter — pre-existing uncommitted clutter shouldn't be attributed to
// this session). Throws on git failure; callers skip the repo.
function changedFilesSince(repoDir: string, createdMs: number): string[] {
  const gitOpts = { cwd: repoDir, encoding: 'utf-8' as const, timeout: 10000 };
  const baseline = execFileSync('git', ['log', '--before=' + new Date(createdMs).toISOString(), '-1', '--format=%H'], gitOpts).trim() || EMPTY_TREE;
  const tracked = execFileSync('git', ['diff', '--name-only', baseline], gitOpts).split('\n').filter(Boolean);
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], gitOpts)
    .split('\n')
    .filter(Boolean)
    .filter((f) => {
      try {
        return fs.statSync(path.join(repoDir, f)).mtimeMs >= createdMs;
      } catch {
        return false;
      }
    });
  return [...new Set([...tracked, ...untracked])].map((f) => path.join(repoDir, f));
}

// File-change inventory for the details panel (parity with the chat view's
// Vault Documents / Code Files sections). Terminal sessions have no message
// log to scan — the TUI runs opaque inside the PTY — so git is the witness:
// the session's cwd repo supplies code files and the active-mode vault repos
// supply vault documents, each diffed from just before the session began.
// Files under a vault path are bucketed as vault docs wherever they came
// from, so a session cwd'd into a vault doesn't double-report.
export function terminalSessionFiles(req: Request, res: Response): void {
  const name = sanitizeSession(String(req.params.name || ''));
  const mode = parseMode(req.query.mode) || 'work';
  execFile(TMUX, ['display-message', '-p', '-t', name, '#{session_created}'], (err, createdOut) => {
    if (err) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const createdMs = Number(createdOut.trim()) * 1000;
    execFile(TMUX, ['display-message', '-p', '-t', name, '#{pane_current_path}'], (err2, pathOut) => {
      const cwd = err2 ? '' : pathOut.trim();
      const vaults = getActiveModeVaults(mode);
      const isVaultPath = (p: string) => vaults.some((v) => p === v.path || p.startsWith(v.path + path.sep));
      const vaultDocs = new Set<string>();
      const codeFiles = new Set<string>();
      const seenRepos = new Set<string>();
      for (const dir of [cwd, ...vaults.map((v) => v.path)].filter(Boolean)) {
        const root = gitRepoRoot(dir);
        if (!root || seenRepos.has(root)) continue;
        seenRepos.add(root);
        try {
          for (const f of changedFilesSince(root, createdMs)) {
            (isVaultPath(f) ? vaultDocs : codeFiles).add(f);
          }
        } catch {
          /* repo unreadable — skip */
        }
      }
      res.json({ vaultDocs: [...vaultDocs].sort(), codeFiles: [...codeFiles].sort() });
    });
  });
}

// Per-file diff for the details panel — the chat view's file-diff route with
// the baseline taken from tmux's session_created instead of the stored chat
// session. Pre-session state → working tree, so uncommitted edits show.
export function terminalSessionFileDiff(req: Request, res: Response): void {
  const name = sanitizeSession(String(req.params.name || ''));
  const filePath = String(req.query.path || '');
  if (!filePath) {
    res.status(400).json({ error: 'path query parameter required' });
    return;
  }
  execFile(TMUX, ['display-message', '-p', '-t', name, '#{session_created}'], (err, createdOut) => {
    if (err) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const createdMs = Number(createdOut.trim()) * 1000;
    const resolved = path.resolve(filePath);
    const repoDir = gitRepoRoot(path.dirname(resolved));
    if (!repoDir) {
      res.json({ diff: null, message: 'Not a git repository' });
      return;
    }
    const gitOpts = { cwd: repoDir, encoding: 'utf-8' as const, timeout: 10000 };
    const rel = path.relative(repoDir, resolved);
    try {
      const baseline = execFileSync('git', ['log', '--before=' + new Date(createdMs).toISOString(), '-1', '--format=%H'], gitOpts).trim() || EMPTY_TREE;
      let diff = execFileSync('git', ['diff', baseline, '--', rel], gitOpts).trim();
      if (!diff && fs.existsSync(resolved)) {
        // git diff skips untracked files entirely; synthesize the all-additions
        // diff for them. --no-index exits 1 when the files differ, so the
        // output rides on the error object.
        try {
          execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], gitOpts);
        } catch {
          try {
            execFileSync('git', ['diff', '--no-index', '--', '/dev/null', rel], gitOpts);
          } catch (e: any) {
            diff = String(e.stdout || '').trim();
          }
        }
      }
      res.json(diff ? { diff, path: resolved } : { diff: null, message: 'No changes during this session' });
    } catch {
      res.json({ diff: null, message: 'Failed to retrieve git diff' });
    }
  });
}

export function terminalKillSession(req: Request, res: Response): void {
  const name = sanitizeSession(String(req.params.name || ''));
  execFile(TMUX, ['kill-session', '-t', name], (err) => {
    if (err) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    // Prune the snapshot file directly: if this was the last session the tmux
    // server died with it, and the list-based snapshot would skip the rewrite.
    pruneTerminalSnapshot(name);
    scheduleTerminalSnapshot();
    res.json({ killed: name });
  });
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
      const mode = url.searchParams.get('mode');
      startSession(
        ws,
        sanitizeSession(url.searchParams.get('session')),
        mode === 'work' || mode === 'personal' ? mode : '',
        url.searchParams.get('cwd') || ''
      );
    });
  });

  console.log(`[terminal] WebSocket terminal attached at ${TERMINAL_PATH}`);
}

function startSession(ws: WebSocket, session: string, mode: string, cwd: string): void {
  const shell = process.env.SHELL || '/bin/zsh';
  // Client-supplied start directory (sidebar dir picker). A brand-new tmux
  // session inherits the creating client's cwd, so setting the PTY cwd is
  // enough — attaches to existing sessions ignore it. Validate before use: a
  // nonexistent cwd would fail the PTY spawn outright.
  let startDir = process.env.HOME;
  try {
    if (cwd && path.isAbsolute(cwd) && fs.statSync(cwd).isDirectory()) startDir = cwd;
  } catch {
    /* nonexistent — keep HOME */
  }
  const opts = shellExecOpts({
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: startDir,
  });
  // Web-terminal shells are NOT bridge chat sessions. shellExecOpts spreads
  // process.env, so a bridge started from a bridge-spawned shell would leak
  // CHAT_BRIDGE_SESSION into the PTY — and the first PTY to start the tmux
  // server bakes it into tmux's global env, making the permission hook deny
  // every interactive claude run inside tmux. Strip the markers.
  delete (opts.env as Record<string, unknown>).CHAT_BRIDGE_SESSION;
  delete (opts.env as Record<string, unknown>).CHAT_BRIDGE_SESSION_STORE;

  // Login shell (-l) so rc files rebuild the full PATH (incl. ~/.local/bin for
  // `claude`) under launchd's minimal env; exec tmux so closing tmux ends the PTY.
  // mouse on (session-scoped via the command chain, which re-runs on every
  // attach so existing sessions get it too) so wheel/touch scroll reaches tmux's
  // scrollback. Under mouse on a plain drag is captured by tmux into its paste
  // buffer rather than an xterm selection (the shift-bypass proved unreliable
  // through the xterm->tmux->claude nesting); the browser Cmd+C handler reads
  // that buffer back via GET /api/terminal/clipboard, so copy and scrollback
  // coexist.
  // Tag the session with the context tab active when it was opened. -o keeps
  // an existing tag (re-attaching under the other tab must not re-home the
  // session); -q silences the "already set" error -o would otherwise print.
  // mode is validated to a literal 'work'/'personal' at the upgrade handler.
  const tag = mode ? ` \\; set-option -oq @bridge_mode ${mode}` : '';
  // Single-quote the session name so names with spaces don't word-split into
  // separate tmux args. sanitizeSession forbids "'" (and every other shell
  // metacharacter), so the wrap can't be broken out of — no escaping needed.
  // terminal-features tells tmux what the outer terminal (xterm.js) can take,
  // keyed on the PTY's TERM (xterm-256color, set above). Requires tmux 3.2+.
  //   RGB — 24-bit color passes through instead of being quantized to 256.
  //   clipboard + set-clipboard on — buffer sets (mouse drag-release, copy-mode
  //   y) emit OSC 52 down the PTY; the browser's clipboard addon writes it to
  //   the attached device's clipboard. tmux only emits OSC 52 when the feature
  //   flag says the outer terminal supports it.
  const term = pty.spawn(shell, ['-lc', `exec ${TMUX} new -A -s '${session}'${tag} \\; set-option mouse on \\; set-option -sa terminal-features ',xterm-256color:RGB:clipboard' \\; set-option -s set-clipboard on`], opts as pty.IPtyForkOptions);

  let creationSnapshotted = false;
  term.onData((data) => {
    // First output means tmux is up and the attach-or-create has run — capture
    // a possibly brand-new session in the reboot snapshot.
    if (!creationSnapshotted) {
      creationSnapshotted = true;
      scheduleTerminalSnapshot();
    }
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  term.onExit(() => {
    // An `exit` inside tmux ends the session itself (not just this client) — re-list.
    scheduleTerminalSnapshot();
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
