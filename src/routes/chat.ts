import { Router, Request, Response } from 'express';
import { runClaude, isSessionBusy } from '../services/claude-runner';
import { getSession, updateSession, addMessage } from '../services/session-store';

const router = Router();

router.post('/:sessionId', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const { message } = req.body;

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

  const sendSSE = (event: string, data: string) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let assistantText = '';

  runClaude({
    sessionId: session.claudeSessionId || undefined,
    message,
    onEvent: (event) => {
      sendSSE(event.type, event.data);
      // Accumulate assistant text
      if (event.type === 'text') {
        assistantText += event.data;
      }
      // Save tool use
      if (event.type === 'tool_use') {
        try {
          const tool = JSON.parse(event.data);
          addMessage(sessionId, 'tool', tool.name);
        } catch {
          addMessage(sessionId, 'tool', event.data);
        }
      }
      // Save usage
      if (event.type === 'done') {
        addMessage(sessionId, 'usage', event.data);
      }
    },
    onClose: (claudeSessionId) => {
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
    // The claude process will continue running and complete naturally
    // This is fine - we just won't send more events
  });
});

export default router;
