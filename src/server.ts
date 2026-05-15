import express from 'express';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { config } from './config';
import chatRoutes from './routes/chat';
import sessionRoutes from './routes/sessions';
import permissionRoutes from './routes/permissions';
import vaultRoutes from './routes/vault';
import tasksRoutes from './routes/tasks';
import settingsRoutes from './routes/settings';
import ttsRoutes from './routes/tts';
import { startReaper, shutdownAll } from './services/session-reaper';
import { resolveShellEnv } from './services/shell-env';

const app = express();

// No CORS middleware: the frontend is served same-origin from this server,
// the hook script uses curl (no Origin header), and nothing else legitimately
// makes cross-origin browser calls to this API. Without an Access-Control-Allow-Origin
// header, browsers block cross-origin reads, which prevents drive-by attacks
// from arbitrary tabs reaching localhost or the Tailscale IP.
app.use(express.json({ limit: '10mb' }));

// Access log: one line per HTTP request to stdout (which launchd captures into
// chat-bridge.log). Skipped for SSE streams since those are long-lived and the
// payloads are already richly logged at the event level.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/chat/')) { next(); return; }
  const start = Date.now();
  res.on('finish', () => {
    const ip = req.socket.remoteAddress || '-';
    console.log(`[http] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms ${ip}`);
  });
  next();
});

// Static files — no caching to ensure latest code is always served
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  },
}));

// API routes
app.use('/api/chat', chatRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/permissions', permissionRoutes);
app.use('/api/vault', vaultRoutes);
app.use('/api/vault/tasks', tasksRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/tts', ttsRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve index.html for all non-API routes (SPA fallback)
app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Resolve the user's full shell PATH before starting the server,
// so child processes (npm, claude, git) work under launchd.
resolveShellEnv().then(startServer);

function startServer() {
  // Diagnostic startup banner — correlates restart events with per-invocation
  // --resume decisions in claude-runner. After a bridge restart, the next
  // [resume:...] line tells us whether the persisted claudeSessionId survived
  // (mode=resume) or was lost (mode=fresh).
  const bridgeStartId = randomBytes(4).toString('hex');
  console.log(`[bridge-start] pid=${process.pid} bridgeStartId=${bridgeStartId} time=${new Date().toISOString()}`);

  // Determine HTTP vs HTTPS mode
  const args = process.argv.slice(2);
  const useHttp = args.includes('--http');

  if (useHttp) {
    const server = http.createServer(app);
    server.listen(config.port, '0.0.0.0', () => {
      console.log(`Chat Bridge running on HTTP at http://0.0.0.0:${config.port}`);
      startReaper();
    });
  } else {
    // HTTPS mode (default)
    try {
      const certPath = path.join(config.certsPath, 'cert.pem');
      const keyPath = path.join(config.certsPath, 'key.pem');

      if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
        console.error('HTTPS certificates not found in', config.certsPath);
        console.error('Either place cert.pem and key.pem in the certs/ directory,');
        console.error('or run with --http for plain HTTP mode.');
        process.exit(1);
      }

      const httpsOptions = {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
      };

      const server = https.createServer(httpsOptions, app);

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`Port ${config.port} is already in use`);
        } else {
          console.error('Server error:', err.message);
        }
        process.exit(1);
      });

      server.listen(config.port, '0.0.0.0', () => {
        console.log(`Chat Bridge running on HTTPS at https://0.0.0.0:${config.port}`);
        startReaper();
      });
    } catch (err: any) {
      console.error('Failed to start HTTPS server:', err.message);
      process.exit(1);
    }
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  shutdownAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  shutdownAll();
  process.exit(0);
});
