import { Router, Request, Response } from 'express';
import { getAppSessionByClaudeId, emitToStream, removeFromStreamBuffer } from '../services/claude-runner';
import { getSession } from '../services/session-store';
import { getObsidianRoot } from '../config';
import {
  checkPermission,
  isNeverAllowed,
  isSessionAllowed,
  isDirectoryTrusted,
  trustDirectory,
  createPermissionRequest,
  resolvePermission,
  getPendingForSession,
} from '../services/permissions';

const router = Router();
const pollCount = new Map<string, number>();

// Called by the PreToolUse hook script — held open until user responds
router.post('/request', async (req: Request, res: Response) => {
  const { tool_name, tool_input, session_id } = req.body;

  if (!tool_name || !session_id) {
    res.status(400).json({ error: 'tool_name and session_id required' });
    return;
  }

  // Look up the app session from Claude's session ID
  const appSessionId = getAppSessionByClaudeId(session_id);
  if (!appSessionId) {
    // No active bridge session — auto-allow (might be terminal usage)
    res.json({ decision: 'allow' });
    return;
  }

  const session = getSession(appSessionId);
  const workingDir = session?.workingDir;

  // Deny tools incompatible with bridge context before any early-return allows.
  // Without this, the vault-dir and session-allow checks below would let them through.
  if (isNeverAllowed(tool_name)) {
    console.log(`[permissions] auto-deny (incompatible with bridge): ${tool_name}`);
    res.json({ decision: 'deny' });
    return;
  }

  // Auto-allow all operations inside vault directories (no confirmation needed)
  const VAULT_DIRS = [getObsidianRoot() + '/'];
  if (workingDir && VAULT_DIRS.some(v => workingDir.startsWith(v))) {
    console.log(`[permissions] auto-allow (vault dir): ${tool_name} in ${workingDir}`);
    res.json({ decision: 'allow' });
    return;
  }

  // Check session-level allow-all (user previously clicked "Allow All" for this tool)
  if (isSessionAllowed(appSessionId, tool_name)) {
    console.log(`[permissions] session-allow: ${tool_name}`);
    res.json({ decision: 'allow' });
    return;
  }

  // Run the unified permission check
  const verdict = checkPermission(tool_name, tool_input || {}, workingDir);

  if (verdict === 'deny') {
    console.log(`[permissions] auto-deny (incompatible with bridge): ${tool_name}`);
    res.json({ decision: 'deny' });
    return;
  }

  if (verdict === 'allow') {
    const preview = tool_name === 'Bash'
      ? ((tool_input?.command as string) || '').substring(0, 80)
      : tool_name;
    console.log(`[permissions] auto-allow: ${preview}`);
    res.json({ decision: 'allow' });
    return;
  }

  // --- verdict === 'ask' — prompt the user ---

  console.log(`[permissions] ASKING USER: ${tool_name}`, tool_input ? JSON.stringify(tool_input).substring(0, 200) : '');
  const decision = createPermissionRequest(appSessionId, tool_name, tool_input || {});

  // Send SSE event to the client through the active stream
  const pending = getPendingForSession(appSessionId);
  if (pending) {
    emitToStream(appSessionId, {
      type: 'permission_request',
      data: JSON.stringify({
        id: pending.id,
        toolName: pending.toolName,
        toolInput: pending.toolInput,
      }),
    });
    console.log(`[permissions] SSE event sent for request ${pending.id}`);
  } else {
    console.log(`[permissions] WARNING: no pending request found after creation`);
  }

  // Wait for user response (or timeout)
  const result = await decision;
  console.log(`[permissions] user decision: ${result} for ${tool_name}`);
  res.json({ decision: result });
});

// Poll for pending permission request (fallback for SSE delivery issues)
router.get('/pending/:sessionId', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const pending = getPendingForSession(sessionId);
  const count = (pollCount.get(sessionId) || 0) + 1;
  pollCount.set(sessionId, count);
  if (pending) {
    console.log(`[permissions-poll] HIT session=${sessionId.slice(0, 8)} tool=${pending.toolName} poll#${count}`);
    res.json({
      id: pending.id,
      toolName: pending.toolName,
      toolInput: pending.toolInput,
    });
  } else {
    // Log first poll and every 30th (~1/min) to confirm polling is active
    if (count === 1 || count % 30 === 0) {
      console.log(`[permissions-poll] active session=${sessionId.slice(0, 8)} poll#${count}`);
    }
    res.json(null);
  }
});

// Called by the client with user's decision
router.post('/respond', (req: Request, res: Response) => {
  const { requestId, decision, allowAll } = req.body;

  if (!requestId || !decision) {
    res.status(400).json({ error: 'requestId and decision required' });
    return;
  }

  if (decision !== 'allow' && decision !== 'deny') {
    res.status(400).json({ error: 'decision must be "allow" or "deny"' });
    return;
  }

  console.log(`[permissions] /respond: requestId=${requestId} decision=${decision} allowAll=${allowAll}`);
  const result = resolvePermission(requestId, decision, allowAll === true);
  console.log(`[permissions] /respond resolved=${result.resolved}`);
  if (result.resolved) {
    // Scrub resolved permission_request events from the session's stream buffer so
    // a subsequent /reconnect replay (e.g. user switches away and back mid-tool-call)
    // can't resurrect the dialog with a now-dead request ID.
    if (result.appSessionId) {
      const resolvedIds = new Set(result.resolvedRequestIds);
      removeFromStreamBuffer(result.appSessionId, (event) => {
        if (event.type !== 'permission_request') return false;
        try {
          const parsed = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          return resolvedIds.has(parsed?.id);
        } catch {
          return false;
        }
      });
    }
    res.json({ status: 'ok' });
  } else {
    console.warn(`[permissions] /respond FAILED: no pending permission for ${requestId}`);
    res.status(404).json({ error: 'No pending permission with that ID' });
  }
});

// ---------------------------------------------------------------------------
// Directory trust endpoints
// ---------------------------------------------------------------------------

// Check if a directory is trusted
router.get('/directory-trust', (req: Request, res: Response) => {
  const dir = req.query.dir as string;
  if (!dir) {
    res.status(400).json({ error: 'dir query parameter required' });
    return;
  }

  res.json({ dir, trusted: isDirectoryTrusted(dir) });
});

// Trust a directory
router.post('/directory-trust', (req: Request, res: Response) => {
  const { dir } = req.body;
  if (!dir) {
    res.status(400).json({ error: 'dir required' });
    return;
  }

  trustDirectory(dir);
  console.log(`[permissions] directory trusted: ${dir}`);
  res.json({ status: 'ok', dir });
});

export default router;
