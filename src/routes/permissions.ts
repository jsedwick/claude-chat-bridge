import { Router, Request, Response } from 'express';
import { getAppSessionByClaudeId, emitToStream } from '../services/claude-runner';
import {
  isAutoAllowed,
  isSessionAllowed,
  createPermissionRequest,
  resolvePermission,
  getPendingForSession,
} from '../services/permissions';

const router = Router();

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

  // Auto-allow safe tools
  if (isAutoAllowed(tool_name)) {
    res.json({ decision: 'allow' });
    return;
  }

  // Check session-level allow-all
  if (isSessionAllowed(appSessionId, tool_name)) {
    res.json({ decision: 'allow' });
    return;
  }

  // Create a pending permission request and emit to the client
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
  }

  // Wait for user response (or timeout)
  const result = await decision;
  res.json({ decision: result });
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

  const resolved = resolvePermission(requestId, decision, allowAll === true);
  if (resolved) {
    res.json({ status: 'ok' });
  } else {
    res.status(404).json({ error: 'No pending permission with that ID' });
  }
});

export default router;
