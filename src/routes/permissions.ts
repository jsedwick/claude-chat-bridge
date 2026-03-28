import { Router, Request, Response } from 'express';
import { getAppSessionByClaudeId, emitToStream } from '../services/claude-runner';
import { getSession } from '../services/session-store';
import {
  isAutoAllowed,
  isBashAskCommand,
  isSessionAllowed,
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

  // Bash: check for git add/commit/push BEFORE generic auto-allow
  if (tool_name === 'Bash') {
    if (!isBashAskCommand(tool_input || {})) {
      console.log(`[permissions] auto-allow bash: ${(tool_input?.command as string || '').substring(0, 80)}`);
      res.json({ decision: 'allow' });
      return;
    }
    // Falls through to vault-dir check, session-allow, or permission dialog
  } else if (isAutoAllowed(tool_name)) {
    // Auto-allow all non-Bash tools
    console.log(`[permissions] auto-allow: ${tool_name}`);
    res.json({ decision: 'allow' });
    return;
  }

  // Auto-allow git operations inside vault directories (no confirmation needed)
  const VAULT_DIRS = ['/Users/jsedwick/Documents/Obsidian/'];
  const session = getSession(appSessionId);
  if (session?.workingDir && VAULT_DIRS.some(v => session.workingDir!.startsWith(v))) {
    console.log(`[permissions] auto-allow (vault dir): ${tool_name} in ${session.workingDir}`);
    res.json({ decision: 'allow' });
    return;
  }

  // Check session-level allow-all
  if (isSessionAllowed(appSessionId, tool_name)) {
    console.log(`[permissions] session-allow: ${tool_name}`);
    res.json({ decision: 'allow' });
    return;
  }

  // Create a pending permission request and emit to the client
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
  const resolved = resolvePermission(requestId, decision, allowAll === true);
  console.log(`[permissions] /respond resolved=${resolved}`);
  if (resolved) {
    res.json({ status: 'ok' });
  } else {
    console.warn(`[permissions] /respond FAILED: no pending permission for ${requestId}`);
    res.status(404).json({ error: 'No pending permission with that ID' });
  }
});

export default router;
