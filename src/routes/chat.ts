import { Router, Request, Response } from 'express';
import { runClaude, isSessionBusy, cancelByAppSession, isStreamActive, getStreamBuffer, subscribeToStream } from '../services/claude-runner';
import { getSession, updateSession, addMessage, updateToolMessage } from '../services/session-store';

const router = Router();

router.post('/:sessionId', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const { message, model, attachments } = req.body;

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  if (isSessionBusy(session.claudeSessionId || sessionId as string)) {
    res.status(409).json({ error: 'Session is busy processing a message' });
    return;
  }

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Save user message server-side
  addMessage(sessionId, 'user', message);

  // Auto-name session from first message
  if (session.messageCount === 0) {
    const name = message.length <= 50 ? message : message.substring(0, 50).replace(/\s+\S*$/, '…');
    updateSession(sessionId, { name });
  }

  const sendSSE = (event: string, data: string) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Keepalive ping every 15s to prevent idle connection drops
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch {}
  }, 15000);

  let assistantText = '';

  runClaude({
    sessionId: session.claudeSessionId || undefined,
    appSessionId: sessionId,
    message: message,
    model: model || undefined,
    workingDir: session.workingDir || undefined,
    attachments: attachments || undefined,
    onEvent: (event) => {
      // Handle _update tool_use events (from assistant message with complete data)
      // These only update persistence — don't send to client (it already has the item from stream)
      if (event.type === 'tool_use') {
        try {
          const toolData = JSON.parse(event.data);
          if (toolData._update) {
            updateToolMessage(sessionId, toolData.id, event.data);
            return;
          }
        } catch {}
        sendSSE(event.type, event.data);
        addMessage(sessionId, 'tool', event.data);
        return;
      }

      sendSSE(event.type, event.data);

      // Accumulate assistant text
      if (event.type === 'text') {
        assistantText += event.data;
      }
      // Save tool result for restore
      if (event.type === 'tool_result') {
        addMessage(sessionId, 'tool_result', event.data);
      }
      // Save usage
      if (event.type === 'done') {
        addMessage(sessionId, 'usage', event.data);
      }
    },
    onClose: (claudeSessionId) => {
      clearInterval(keepalive);
      // Save accumulated assistant response
      if (assistantText) {
        addMessage(sessionId, 'assistant', assistantText);
      }
      // Update session metadata
      updateSession(sessionId, {
        claudeSessionId: claudeSessionId || session.claudeSessionId,
        lastMessage: message.substring(0, 200),
        messageCount: session.messageCount + 1,
      });

      res.write('event: close\ndata: "done"\n\n');
      res.end();
    },
  });

  // Handle client disconnect
  req.on('close', () => {
    clearInterval(keepalive);
    // The claude process will continue running and complete naturally
    // This is fine - we just won't send more events
  });
});

router.get('/:sessionId/reconnect', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const buffer = getStreamBuffer(sessionId);
  const streamActive = isStreamActive(sessionId);

  if (!buffer) {
    res.status(404).json({ error: 'No stream data available' });
    return;
  }

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const sendSSE = (event: string, data: string) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Replay buffered events (skip _update tool_use — persistence only)
  for (const event of buffer) {
    if (event.type === 'tool_use') {
      try { if (JSON.parse(event.data)._update) continue; } catch {}
    }
    sendSSE(event.type, event.data);
  }

  if (!streamActive) {
    // Stream already finished — just send close after replay
    res.write('event: close\ndata: "done"\n\n');
    res.end();
    return;
  }

  // Keepalive ping every 15s
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch {}
  }, 15000);

  // Subscribe to live events going forward (skip _update tool_use)
  const unsubscribe = subscribeToStream(sessionId, (event) => {
    if (event.type === 'tool_use') {
      try { if (JSON.parse(event.data)._update) return; } catch {}
    }
    sendSSE(event.type, event.data);
  });

  if (!unsubscribe) {
    clearInterval(keepalive);
    res.write('event: close\ndata: "done"\n\n');
    res.end();
    return;
  }

  // When stream finishes, the close event will come through the subscriber
  // but we also need to end the response
  const checkDone = setInterval(() => {
    if (!isStreamActive(sessionId)) {
      clearInterval(checkDone);
      clearInterval(keepalive);
      unsubscribe();
      res.write('event: close\ndata: "done"\n\n');
      res.end();
    }
  }, 500);

  req.on('close', () => {
    clearInterval(checkDone);
    clearInterval(keepalive);
    unsubscribe();
  });
});

router.post('/:sessionId/cancel', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const cancelled = cancelByAppSession(sessionId);
  if (cancelled) {
    res.json({ status: 'cancelled' });
  } else {
    res.status(404).json({ error: 'No active stream for this session' });
  }
});

export default router;
