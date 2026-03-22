import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { StreamEvent, ClaudeRunnerOptions } from '../types';

const UPLOAD_DIR = '/tmp/claude-chat-bridge/uploads';

const activeSessions = new Map<string, ChildProcess>();
// Maps app session ID → tracking ID for cancel support
const appSessionMap = new Map<string, string>();

// Stream buffering and pub/sub for reconnect support
interface ActiveStream {
  buffer: StreamEvent[];
  listeners: Set<(event: StreamEvent) => void>;
  done: boolean;
}
const activeStreams = new Map<string, ActiveStream>();
const STREAM_BUFFER_TTL = 60_000; // Keep buffer 60s after stream ends

function getOrCreateStream(appSessionId: string): ActiveStream {
  let stream = activeStreams.get(appSessionId);
  if (!stream) {
    stream = { buffer: [], listeners: new Set(), done: false };
    activeStreams.set(appSessionId, stream);
  }
  return stream;
}

function emitToStream(appSessionId: string, event: StreamEvent): void {
  const stream = activeStreams.get(appSessionId);
  if (!stream) return;
  stream.buffer.push(event);
  for (const listener of stream.listeners) {
    listener(event);
  }
}

function closeStream(appSessionId: string): void {
  const stream = activeStreams.get(appSessionId);
  if (stream) {
    stream.done = true;
    // Clean up after TTL
    setTimeout(() => activeStreams.delete(appSessionId), STREAM_BUFFER_TTL);
  }
}

export function isStreamActive(appSessionId: string): boolean {
  const stream = activeStreams.get(appSessionId);
  return !!stream && !stream.done;
}

export function getStreamBuffer(appSessionId: string): StreamEvent[] | null {
  const stream = activeStreams.get(appSessionId);
  return stream ? [...stream.buffer] : null;
}

export function subscribeToStream(appSessionId: string, listener: (event: StreamEvent) => void): (() => void) | null {
  const stream = activeStreams.get(appSessionId);
  if (!stream) return null;
  stream.listeners.add(listener);
  return () => stream.listeners.delete(listener);
}

export function getActiveSessionCount(): number {
  return activeSessions.size;
}

export function isSessionBusy(sessionId: string): boolean {
  return activeSessions.has(sessionId);
}

export function killSession(sessionId: string): void {
  const proc = activeSessions.get(sessionId);
  if (proc) {
    proc.kill('SIGTERM');
    activeSessions.delete(sessionId);
  }
}

export function cancelByAppSession(appSessionId: string): boolean {
  const trackingId = appSessionMap.get(appSessionId);
  if (trackingId) {
    killSession(trackingId);
    appSessionMap.delete(appSessionId);
    return true;
  }
  return false;
}

export function runClaude(options: ClaudeRunnerOptions): void {
  const { sessionId, appSessionId, message, model, workingDir, attachments, onEvent, onClose } = options;

  if (activeSessions.size >= config.maxConcurrentSessions && !activeSessions.has(sessionId || '')) {
    onEvent({ type: 'error', data: `Max concurrent sessions (${config.maxConcurrentSessions}) reached. Try again later.` });
    onClose(null);
    return;
  }

  // Save any image attachments to temp files
  const savedFiles: string[] = [];
  if (attachments?.length) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    for (const att of attachments) {
      const ext = att.filename.split('.').pop() || 'png';
      const filename = `${crypto.randomUUID()}.${ext}`;
      const filepath = path.join(UPLOAD_DIR, filename);
      // att.path contains base64 data
      const base64Data = att.path.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));
      savedFiles.push(filepath);
    }
  }

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', config.permissionMode,
  ];

  if (model) {
    args.push('--model', model);
  }

  // Add uploaded images directory
  if (savedFiles.length > 0) {
    args.push('--add-dir', UPLOAD_DIR);
  }

  if (sessionId) {
    args.push('--resume', sessionId);
  }

  // Build message with image references
  let fullMessage = message;
  if (savedFiles.length > 0) {
    const refs = savedFiles.map(f => f).join(', ');
    fullMessage = `${message}\n\n[Attached image(s): ${refs}]`;
  }

  args.push(fullMessage);

  const proc = spawn(config.claudePath, args, {
    cwd: workingDir || config.workingDir,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const trackingId = sessionId || 'pending-' + Date.now();
  activeSessions.set(trackingId, proc);
  appSessionMap.set(appSessionId, trackingId);

  // Set up stream buffer and register initial listener
  const stream = getOrCreateStream(appSessionId);
  stream.listeners.add(onEvent);

  let capturedSessionId: string | null = sessionId || null;
  let buffer = '';

  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const event = parseClaudeEvent(parsed);
        if (event) {
          emitToStream(appSessionId, event);
        }

        // Capture session ID from init event
        if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
          capturedSessionId = parsed.session_id;
        }

        // Capture session ID from result event
        if (parsed.type === 'result' && parsed.session_id) {
          capturedSessionId = parsed.session_id;
          const usage = parsed.usage;
          const cost = parsed.total_cost_usd;
          emitToStream(appSessionId, {
            type: 'done',
            data: JSON.stringify({
              session_id: parsed.session_id,
              duration_ms: parsed.duration_ms,
              cost_usd: cost,
              input_tokens: usage?.input_tokens,
              output_tokens: usage?.output_tokens,
            }),
          });
        }
      } catch {
        // Non-JSON line, skip
      }
    }
  });

  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    // Filter out expected hook noise
    if (text && !text.includes('Hook cancelled') && !text.includes('hook')) {
      emitToStream(appSessionId, { type: 'error', data: text });
    }
  });

  proc.on('close', (code) => {
    activeSessions.delete(trackingId);
    appSessionMap.delete(appSessionId);
    if (capturedSessionId && trackingId !== capturedSessionId) {
      activeSessions.delete(capturedSessionId);
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer);
        if (parsed.type === 'result' && parsed.session_id) {
          capturedSessionId = parsed.session_id;
        }
      } catch {
        // ignore
      }
    }

    // Clean up temp image files
    for (const f of savedFiles) {
      try { fs.unlinkSync(f); } catch {}
    }

    if (code !== 0 && code !== null) {
      emitToStream(appSessionId, { type: 'error', data: `Claude process exited with code ${code}` });
    }

    // Remove the initial listener and close the stream
    stream.listeners.delete(onEvent);
    closeStream(appSessionId);
    onClose(capturedSessionId);
  });

  proc.on('error', (err) => {
    activeSessions.delete(trackingId);
    emitToStream(appSessionId, { type: 'error', data: `Failed to spawn claude: ${err.message}` });
    stream.listeners.delete(onEvent);
    closeStream(appSessionId);
    onClose(null);
  });
}

function parseClaudeEvent(parsed: any): StreamEvent | null {
  // Init event
  if (parsed.type === 'system' && parsed.subtype === 'init') {
    return { type: 'init', data: JSON.stringify({ session_id: parsed.session_id }) };
  }

  // Stream events
  if (parsed.type === 'stream_event' && parsed.event) {
    const evt = parsed.event;

    // Text delta
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
      return { type: 'text', data: evt.delta.text };
    }

    // Thinking delta
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'thinking_delta') {
      return { type: 'thinking', data: evt.delta.thinking };
    }

    // Tool use start
    if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
      return {
        type: 'tool_use',
        data: JSON.stringify({
          id: evt.content_block.id,
          name: evt.content_block.name,
        }),
      };
    }

    // Tool result
    if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_result') {
      return {
        type: 'tool_result',
        data: JSON.stringify({
          tool_use_id: evt.content_block.tool_use_id,
          content: evt.content_block.content,
        }),
      };
    }
  }

  // Assistant message with tool results
  if (parsed.type === 'assistant' && parsed.message?.content) {
    for (const block of parsed.message.content) {
      if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          data: JSON.stringify({ id: block.id, name: block.name, input: block.input }),
        };
      }
    }
  }

  return null;
}
