import express from 'express';
import cors from 'cors';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import chatRoutes from './routes/chat';
import sessionRoutes from './routes/sessions';

const app = express();

app.use(cors());
app.use(express.json());

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api/chat', chatRoutes);
app.use('/api/sessions', sessionRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve index.html for all non-API routes (SPA fallback)
app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Determine HTTP vs HTTPS mode
const args = process.argv.slice(2);
const useHttp = args.includes('--http');

if (useHttp) {
  const server = http.createServer(app);
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`Chat Bridge running on HTTP at http://0.0.0.0:${config.port}`);
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
    });
  } catch (err: any) {
    console.error('Failed to start HTTPS server:', err.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  process.exit(0);
});
