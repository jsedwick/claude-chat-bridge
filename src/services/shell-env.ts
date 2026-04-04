import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Captures the user's full login-shell PATH so that child processes
 * (npm, claude, git) can be found even when the bridge runs under
 * launchd, which provides only a minimal environment.
 */
let shellPath: string | null = null;

export async function resolveShellEnv(): Promise<void> {
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const { stdout } = await execFileAsync(shell, ['-lc', 'echo $PATH'], { timeout: 5000 });
    shellPath = stdout.trim();
  } catch {
    // Fall back to whatever PATH the process already has
    shellPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  }
}

/** Returns exec options with the user's full shell PATH injected. */
export function shellExecOpts(extra?: Record<string, any>): Record<string, any> {
  return {
    ...extra,
    env: { ...process.env, PATH: shellPath || process.env.PATH },
  };
}
