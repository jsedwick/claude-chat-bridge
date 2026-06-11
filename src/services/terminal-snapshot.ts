import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { config } from '../config';
import { shellExecOpts } from './shell-env';

// Bridge-native terminal-session persistence (Decision 004, Phase 3). tmux-backed
// terminals survive bridge restarts and browser reconnects, but a reboot kills the
// tmux server and every session in it. This module snapshots the session list to
// disk after every lifecycle mutation and recreates missing sessions (detached) at
// bridge startup — names, cwds, and @bridge_* tags — then types `claude --continue`
// into sessions that were running claude. It deliberately does NOT freeze/thaw live
// processes, pane layout, or scrollback: a resumed claude rebuilds its own
// conversation via --continue, the bridge never thaws the process. tmux-resurrect was
// rejected because it drops arbitrary user options: the @bridge_* tags would come
// back stripped and every restored session would land untagged.

const TMUX = '/opt/homebrew/bin/tmux';

// One persisted session. isClaude drives the `claude --continue` resume increment:
// restore brings back shell + cwd + tags, then re-launches claude in sessions that
// were running it at snapshot time (skipping trashed ones).
interface SnapshotEntry {
  name: string;
  cwd: string;
  mode: string;
  archived: boolean;
  trashed: boolean;
  isClaude: boolean;
}

// Same colon-separated convention as terminalSessions: the leading five fields
// are colon-free (sanitized name, validated mode, flag bits, a 1/0 comparison
// result), so everything past them is rejoined as the cwd, immune to colons
// inside paths. The claude check is evaluated tmux-side so only 1/0 reaches the
// output: the native claude launcher execs a versioned binary, so a running TUI
// reports pane_current_command as a bare semver ("2.1.172") — match that OR the
// literal "claude" in case the packaging changes.
const LIST_FORMAT =
  '#{session_name}:#{@bridge_mode}:#{@bridge_archived}:#{@bridge_trashed}:#{||:#{==:#{pane_current_command},claude},#{m/r:^[0-9]+\\.[0-9]+\\.[0-9]+$,#{pane_current_command}}}:#{pane_current_path}';

function readSnapshot(): SnapshotEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(config.terminalSnapshotPath, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // missing or corrupt — nothing to restore
  }
}

function writeSnapshot(entries: SnapshotEntry[]): void {
  // temp + rename so a crash mid-write can't corrupt the store (matches session-store).
  const tmp = `${config.terminalSnapshotPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, config.terminalSnapshotPath);
}

// Re-snapshot from the authoritative tmux list — never from in-memory state,
// which could persist pending/phantom entries. When the tmux server is down the
// last snapshot is KEPT rather than overwritten with []: at OS shutdown launchd
// kills tmux and the bridge in arbitrary order, and a final empty write here
// would wipe exactly the state a reboot needs. The cost: a session whose exit
// took the whole server down can resurrect once; pruneTerminalSnapshot covers
// the common case (explicit tab delete) by editing the file directly.
function takeSnapshot(): void {
  execFile(TMUX, ['list-sessions', '-F', LIST_FORMAT], (err, stdout) => {
    if (err) return;
    const entries = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(':');
        const [name, mode, archived, trashed, isClaude] = parts;
        return {
          name,
          mode: mode || '',
          archived: archived === '1',
          trashed: trashed === '1',
          isClaude: isClaude === '1',
          cwd: parts.slice(5).join(':'),
        };
      });
    try {
      writeSnapshot(entries);
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
    writeSnapshot(readSnapshot().filter((e) => e.name !== name));
  } catch {
    /* best-effort */
  }
}

// Recreate snapshotted sessions missing from tmux, detached (no client needed):
// a shell at the saved cwd plus the saved @bridge_* tags. Skipping names that
// already exist makes this idempotent — a bridge restart with a surviving tmux
// server is a no-op rather than a duplicator. The first new-session also
// (re)starts the tmux server itself, so reboot restore needs no boot hook.
// Trashed sessions are recreated tagged-trashed (not dropped) so the user can
// still restore-or-purge them after a reboot; mouse-on stays in startSession's
// attach chain, which runs on every WS attach.
export function restoreTerminalSessions(): void {
  const entries = readSnapshot();

  // Same scrub as startSession: the first tmux command after a reboot starts
  // the server and bakes this process's env into tmux's global env — a leaked
  // CHAT_BRIDGE_SESSION there makes the permission hook deny every interactive
  // claude inside tmux.
  const opts = shellExecOpts();
  delete (opts.env as Record<string, unknown>).CHAT_BRIDGE_SESSION;
  delete (opts.env as Record<string, unknown>).CHAT_BRIDGE_SESSION_STORE;

  execFile(TMUX, ['list-sessions', '-F', '#{session_name}'], opts, (listErr, stdout) => {
    const existing = new Set(listErr ? [] : String(stdout).trim().split('\n').filter(Boolean));
    let restored = 0;
    for (const e of entries) {
      if (!e.name || existing.has(e.name)) continue;
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
      restored++;
      execFile(TMUX, args, opts, (err) => {
        if (err) {
          console.error(`[terminal-restore] failed for "${e.name}": ${err.message}`);
          return;
        }
        // Resume increment: a session that was running claude at snapshot time gets
        // `claude --continue` typed into its restored shell, reopening the last
        // conversation for that cwd. Sent after creation so the pane exists;
        // keystrokes buffer in the tty until the shell reaches its prompt. Exiting
        // claude drops back to the shell, matching pre-reboot state. Trashed sessions
        // are pending purge — don't spin up claude in them.
        if (e.isClaude && !e.trashed) {
          execFile(TMUX, ['send-keys', '-t', e.name, 'claude --continue', 'Enter'], opts, (sendErr) => {
            if (sendErr) console.error(`[terminal-restore] claude resume failed for "${e.name}": ${sendErr.message}`);
          });
        }
      });
    }
    if (restored) console.log(`[terminal-restore] recreating ${restored} tmux session(s) from snapshot`);
    // Reconcile the file with live truth once the creates have had a moment to land.
    setTimeout(takeSnapshot, 2000).unref();
  });

  // Interval backstop: lifecycle triggers capture creation/tag changes, but a
  // long-lived session's cwd drifts as the user works — refresh periodically so
  // a reboot restores somewhere recent.
  setInterval(takeSnapshot, 5 * 60 * 1000).unref();
}
