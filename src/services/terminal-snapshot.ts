import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { config } from '../config';
import { shellExecOpts } from './shell-env';

// Bridge-native terminal-session persistence (Decision 004, Phase 3). tmux-backed
// terminals survive bridge restarts and browser reconnects, but the tmux server —
// and every session in it — can die at any moment: reboot, crash, stray
// kill-server. This module snapshots the session list to disk after every
// lifecycle mutation and recreates missing sessions (detached) — names, cwds,
// and @bridge_* tags — then types `claude --continue` into sessions that were
// running claude.
//
// Loss-proofing (2026-06-11 incident: a mid-run tmux server death silently took
// 8 sessions; the first new tab on the fresh server then triggered a snapshot
// that overwrote the file with just that tab, destroying the only copy of the
// other sessions' names):
//   - The snapshot records the tmux server pid it was last reconciled against.
//     Entries drop out of the file ONLY while that same server generation is
//     alive — i.e. the session verifiably ended on a server we were watching.
//     When the generation changes, the saved and live lists are MERGED: the
//     missing sessions died with the old server, not by user action, so they
//     are kept on disk and recreated.
//   - A watchdog polls the server. On death (two consecutive failed probes) or
//     an unexpected generation change it restores from the snapshot immediately
//     instead of waiting for the next bridge restart.
//   - Any write that would drop names first copies the previous file to .bak —
//     one generation of undo against an unforeseen clobber path.
//
// It deliberately does NOT freeze/thaw live processes, pane layout, or
// scrollback: a resumed claude rebuilds its own conversation via --continue, the
// bridge never thaws the process. tmux-resurrect was rejected because it drops
// arbitrary user options: the @bridge_* tags would come back stripped and every
// restored session would land untagged.
//
// Accepted trade-off: a session killed outside the bridge while its server is
// down (or via raw `tmux kill-session` racing a generation change) can
// resurrect; explicit bridge kills always prune. Resurrecting a stale shell is
// a minor annoyance — silently losing live sessions is a catastrophe — so every
// ambiguity here resolves toward retention.

const TMUX = '/opt/homebrew/bin/tmux';

// One persisted session. isClaude drives the `claude --continue` resume
// increment: restore brings back shell + cwd + tags, then re-launches claude in
// sessions that were running it at snapshot time (skipping trashed ones).
interface SnapshotEntry {
  name: string;
  cwd: string;
  mode: string;
  archived: boolean;
  trashed: boolean;
  isClaude: boolean;
}

// v2 snapshot file: entries plus the tmux server pid they were last reconciled
// against. serverPid null = not yet reconciled with any live server (fresh
// file, legacy v1 array, or a generation change whose restore hasn't finished).
interface Snapshot {
  serverPid: number | null;
  entries: SnapshotEntry[];
}

// #{pid} (the tmux SERVER pid — same value on every line) leads; the rest is
// the same colon-separated convention as terminalSessions: the leading fields
// are colon-free (numeric pid, sanitized name, validated mode, flag bits, a
// 1/0 comparison result), so everything past them is rejoined as the cwd,
// immune to colons inside paths. The claude check is evaluated tmux-side so
// only 1/0 reaches the output: the native claude launcher execs a versioned
// binary, so a running TUI reports pane_current_command as a bare semver
// ("2.1.172") — match that OR the literal "claude" in case packaging changes.
const LIST_FORMAT =
  '#{pid}:#{session_name}:#{@bridge_mode}:#{@bridge_archived}:#{@bridge_trashed}:#{||:#{==:#{pane_current_command},claude},#{m/r:^[0-9]+\\.[0-9]+\\.[0-9]+$,#{pane_current_command}}}:#{pane_current_path}';

function readSnapshot(): Snapshot {
  try {
    const parsed = JSON.parse(fs.readFileSync(config.terminalSnapshotPath, 'utf-8'));
    if (Array.isArray(parsed)) return { serverPid: null, entries: parsed }; // legacy v1 array
    if (parsed && Array.isArray(parsed.entries)) {
      return { serverPid: typeof parsed.serverPid === 'number' ? parsed.serverPid : null, entries: parsed.entries };
    }
  } catch {
    /* missing or corrupt — nothing to restore */
  }
  return { serverPid: null, entries: [] };
}

function writeSnapshot(snap: Snapshot): void {
  // Back up before any write that drops names — the .bak is the manual escape
  // hatch if a future bug (or an explicit kill the user regrets) loses state.
  try {
    const newNames = new Set(snap.entries.map((e) => e.name));
    if (readSnapshot().entries.some((e) => !newNames.has(e.name))) {
      fs.copyFileSync(config.terminalSnapshotPath, `${config.terminalSnapshotPath}.bak`);
    }
  } catch {
    /* no previous file — nothing to back up */
  }
  // temp + rename so a crash mid-write can't corrupt the store (matches session-store).
  const tmp = `${config.terminalSnapshotPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
  fs.renameSync(tmp, config.terminalSnapshotPath);
}

// Authoritative live state, or null when the tmux server is unreachable.
function listLive(cb: (live: { serverPid: number; entries: SnapshotEntry[] } | null) => void): void {
  execFile(TMUX, ['list-sessions', '-F', LIST_FORMAT], (err, stdout) => {
    if (err) {
      cb(null);
      return;
    }
    let serverPid = 0;
    const entries = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(':');
        const [pid, name, mode, archived, trashed, isClaude] = parts;
        serverPid = Number(pid) || serverPid;
        return {
          name,
          mode: mode || '',
          archived: archived === '1',
          trashed: trashed === '1',
          isClaude: isClaude === '1',
          cwd: parts.slice(6).join(':'),
        };
      });
    cb({ serverPid, entries });
  });
}

// Re-snapshot from the authoritative tmux list — never from in-memory state,
// which could persist pending/phantom entries. Three cases:
//   server down       → keep the last snapshot intact (at OS shutdown launchd
//                       kills tmux and the bridge in arbitrary order; a final
//                       empty write here would wipe exactly the state a reboot
//                       needs — the watchdog handles mid-run deaths instead).
//   same generation   → replace: live is the full truth, and a session missing
//                       from it verifiably ended (user exit / explicit kill).
//   generation change → merge + restore: missing sessions died WITH the old
//                       server. The saved serverPid is kept un-adopted so a
//                       racing snapshot trigger can't flip to replace semantics
//                       and drop them before the restore lands; restore adopts
//                       the new pid once every saved session exists again.
function takeSnapshot(): void {
  listLive((live) => {
    if (!live) return;
    const saved = readSnapshot();
    try {
      if (saved.serverPid === live.serverPid) {
        writeSnapshot({ serverPid: live.serverPid, entries: live.entries });
        return;
      }
      const liveNames = new Set(live.entries.map((e) => e.name));
      const kept = saved.entries.filter((e) => e.name && !liveNames.has(e.name));
      writeSnapshot({ serverPid: saved.serverPid, entries: [...live.entries, ...kept] });
      if (kept.length) {
        console.log(`[terminal-snapshot] tmux server generation changed — kept ${kept.length} missing session(s), restoring`);
        restoreTerminalSessions();
      } else {
        // Nothing lost across the change — adopt the new generation as-is.
        writeSnapshot({ serverPid: live.serverPid, entries: live.entries });
      }
    } catch {
      /* disk hiccup — the next trigger retries */
    }
  });
}

let snapshotTimer: NodeJS.Timeout | null = null;

// Debounced snapshot trigger — chained lifecycle mutations collapse into one
// list+write half a second later.
export function scheduleTerminalSnapshot(): void {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    takeSnapshot();
  }, 500);
  snapshotTimer.unref();
}

// Surgical removal for kill-session: when the killed session was the last one,
// the tmux server exits with it, takeSnapshot skips (server down), and the
// stale entry would resurrect on the next boot.
export function pruneTerminalSnapshot(name: string): void {
  try {
    const snap = readSnapshot();
    writeSnapshot({ serverPid: snap.serverPid, entries: snap.entries.filter((e) => e.name !== name) });
  } catch {
    /* best-effort */
  }
}

let restoring = false;
let shuttingDown = false;

// Called from the SIGTERM handler: a generation flap observed during OS
// shutdown (launchd kills tmux and the bridge in arbitrary order) must not
// spawn a fresh tmux server out of the dying bridge.
export function markTerminalShutdown(): void {
  shuttingDown = true;
}

// Recreate snapshotted sessions missing from tmux, detached (no client
// needed): a shell at the saved cwd plus the saved @bridge_* tags. Skipping
// names that already exist makes this idempotent — safe to call from startup,
// the watchdog, and takeSnapshot's generation handler concurrently with user
// activity. The first new-session also (re)starts the tmux server itself, so
// restore needs no boot hook. Trashed sessions are recreated tagged-trashed
// (not dropped) so the user can still restore-or-purge them; mouse-on stays in
// startSession's attach chain, which runs on every WS attach.
export function restoreTerminalSessions(): void {
  if (restoring || shuttingDown) return;
  restoring = true;
  const { entries } = readSnapshot();

  // Same scrub as startSession: the first tmux command after a server death
  // starts the new server and bakes this process's env into tmux's global env —
  // a leaked CHAT_BRIDGE_SESSION there makes the permission hook deny every
  // interactive claude inside tmux.
  const opts = shellExecOpts();
  delete (opts.env as Record<string, unknown>).CHAT_BRIDGE_SESSION;
  delete (opts.env as Record<string, unknown>).CHAT_BRIDGE_SESSION_STORE;

  execFile(TMUX, ['list-sessions', '-F', '#{session_name}'], opts, (listErr, stdout) => {
    const existing = new Set(listErr ? [] : String(stdout).trim().split('\n').filter(Boolean));
    const missing = entries.filter((e) => e.name && !existing.has(e.name));

    // Every saved session exists again (or nothing was saved): reconcile the
    // file with live truth and adopt the current server generation. From here
    // on, same-generation replace semantics apply.
    const finish = () => {
      restoring = false;
      listLive((live) => {
        if (!live) return;
        try {
          writeSnapshot({ serverPid: live.serverPid, entries: live.entries });
        } catch {
          /* disk hiccup — the next trigger retries */
        }
      });
    };

    let pending = missing.length;
    if (!pending) {
      finish();
      return;
    }
    console.log(`[terminal-restore] recreating ${pending} tmux session(s) from snapshot`);
    for (const e of missing) {
      // Validate the saved cwd exactly as startSession does — repos move.
      let dir = process.env.HOME || '/';
      try {
        if (e.cwd && path.isAbsolute(e.cwd) && fs.statSync(e.cwd).isDirectory()) dir = e.cwd;
      } catch {
        /* gone — keep HOME */
      }
      const args = ['new-session', '-d', '-s', e.name, '-c', dir];
      if (e.mode === 'work' || e.mode === 'personal') args.push(';', 'set-option', '-t', e.name, '@bridge_mode', e.mode);
      if (e.archived) args.push(';', 'set-option', '-t', e.name, '@bridge_archived', '1');
      if (e.trashed) args.push(';', 'set-option', '-t', e.name, '@bridge_trashed', '1');
      execFile(TMUX, args, opts, (err) => {
        if (err) {
          console.error(`[terminal-restore] failed for "${e.name}": ${err.message}`);
        } else if (e.isClaude && !e.trashed) {
          // Resume increment: a session that was running claude at snapshot time
          // gets `claude --continue` typed into its restored shell, reopening the
          // last conversation for that cwd. Sent after creation so the pane
          // exists; keystrokes buffer in the tty until the shell reaches its
          // prompt. Exiting claude drops back to the shell, matching pre-loss
          // state. Trashed sessions are pending purge — don't spin up claude.
          execFile(TMUX, ['send-keys', '-t', e.name, 'claude --continue', 'Enter'], opts, (sendErr) => {
            if (sendErr) console.error(`[terminal-restore] claude resume failed for "${e.name}": ${sendErr.message}`);
          });
        }
        if (--pending === 0) finish();
      });
    }
  });
}

let downStrikes = 0;

// Mid-run loss detection: restore used to run only at bridge startup, so a
// tmux server death while the bridge stayed up left an empty sidebar AND let
// the next snapshot clobber the saved list (the 2026-06-11 incident). The
// watchdog closes that hole from the bridge side; takeSnapshot's generation
// merge closes it from the snapshot side (whichever observes the change first
// wins — both funnel into the same idempotent restore).
function watchdogTick(): void {
  if (shuttingDown || restoring) return;
  listLive((live) => {
    if (shuttingDown || restoring) return;
    if (!live) {
      if (!readSnapshot().entries.some((e) => !e.trashed)) {
        downStrikes = 0; // nothing worth a restore — a dead server is fine
        return;
      }
      // Two consecutive failed probes (~30s) before acting: a single failure
      // could be the opening of an OS shutdown whose SIGTERM hasn't reached us.
      if (++downStrikes < 2) return;
      downStrikes = 0;
      console.log('[terminal-watchdog] tmux server down — restoring sessions from snapshot');
      restoreTerminalSessions();
      return;
    }
    downStrikes = 0;
    const saved = readSnapshot();
    if (saved.serverPid !== null && saved.serverPid !== live.serverPid) {
      console.log('[terminal-watchdog] tmux server generation changed — reconciling');
      takeSnapshot(); // merges, then restores whatever the old server took down
    }
  });
}

// Startup wiring: one restore pass for sessions lost while the bridge was down
// (reboot or crash — idempotent no-op when the tmux server survived a plain
// bridge restart), the cwd-refresh interval (lifecycle triggers capture
// creation/tag changes, but a long-lived session's cwd drifts as the user
// works), and the loss watchdog.
export function initTerminalPersistence(): void {
  restoreTerminalSessions();
  setInterval(takeSnapshot, 5 * 60 * 1000).unref();
  setInterval(watchdogTick, 15 * 1000).unref();
}
