import { Router, Request, Response } from 'express';
import { loadBridgeConfig, saveBridgeConfig } from '../config';

const router = Router();

// Google Cloud TTS API base URL
const GOOGLE_TTS_API = 'https://texttospeech.googleapis.com/v1';

function getApiKey(): string {
  const config = loadBridgeConfig();
  return process.env.CHAT_BRIDGE_GOOGLE_TTS_KEY || config.googleTtsApiKey || '';
}

// GET /api/tts/api-key — check whether an API key is configured (never returns the key itself)
router.get('/api-key', (_req: Request, res: Response) => {
  const key = getApiKey();
  res.json({ configured: !!key, maskedKey: key ? key.slice(0, 6) + '...' + key.slice(-4) : '' });
});

// PUT /api/tts/api-key — save Google TTS API key to bridge-config.json
router.put('/api-key', (req: Request, res: Response) => {
  const { apiKey } = req.body || {};
  if (typeof apiKey !== 'string') {
    res.status(400).json({ error: 'apiKey is required' });
    return;
  }
  const config = loadBridgeConfig();
  if (apiKey) {
    config.googleTtsApiKey = apiKey;
  } else {
    delete config.googleTtsApiKey;
  }
  saveBridgeConfig(config);
  res.json({ configured: !!apiKey });
});

// GET /api/tts/voices — fetch available Google Cloud TTS voices (English only)
router.get('/voices', async (_req: Request, res: Response) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    res.status(400).json({ error: 'No Google Cloud TTS API key configured' });
    return;
  }

  try {
    const response = await fetch(`${GOOGLE_TTS_API}/voices?key=${encodeURIComponent(apiKey)}&languageCode=en`);
    if (!response.ok) {
      const errBody: any = await response.json().catch(() => ({ error: { message: response.statusText } }));
      res.status(response.status).json({ error: errBody.error?.message || 'Google API error' });
      return;
    }
    const data = await response.json() as { voices?: Array<{ name: string; ssmlGender: string; languageCodes: string[]; naturalSampleRateHertz: number }> };

    // Filter to English voices and group by type (Standard, WaveNet, Neural2, Journey, Studio, Polyglot)
    const voices = (data.voices || [])
      .filter(v => v.languageCodes.some(lc => lc.startsWith('en')))
      .map(v => ({
        name: v.name,
        gender: v.ssmlGender,
        languageCodes: v.languageCodes,
        sampleRate: v.naturalSampleRateHertz,
        tier: classifyVoiceTier(v.name),
      }))
      .sort((a, b) => {
        const tierOrder = ['Next Gen', 'Studio', 'Journey', 'Neural2', 'Polyglot', 'WaveNet', 'Standard'];
        return tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier) || a.name.localeCompare(b.name);
      });

    res.json({ voices });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch voices: ' + err.message });
  }
});

// POST /api/tts/synthesize — synthesize speech via Google Cloud TTS
router.post('/synthesize', async (req: Request, res: Response) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    res.status(400).json({ error: 'No Google Cloud TTS API key configured' });
    return;
  }

  const { text, voiceName, languageCode = 'en-US', speakingRate = 1.0 } = req.body || {};
  if (!text || typeof text !== 'string') {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  // Google Cloud TTS has a 5000-byte limit per request
  const truncated = text.slice(0, 5000);

  try {
    const response = await fetch(`${GOOGLE_TTS_API}/text:synthesize?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text: truncated },
        voice: {
          languageCode,
          ...(voiceName ? { name: voiceName } : {}),
        },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: Math.max(0.25, Math.min(4.0, speakingRate)),
        },
      }),
    });

    if (!response.ok) {
      const errBody: any = await response.json().catch(() => ({ error: { message: response.statusText } }));
      res.status(response.status).json({ error: errBody.error?.message || 'Google API error' });
      return;
    }

    const data = await response.json() as { audioContent: string };
    res.json({ audioContent: data.audioContent });
  } catch (err: any) {
    res.status(500).json({ error: 'Synthesis failed: ' + err.message });
  }
});

function classifyVoiceTier(name: string): string {
  if (name.includes('Studio')) return 'Studio';
  if (name.includes('Journey')) return 'Journey';
  if (name.includes('Neural2')) return 'Neural2';
  if (name.includes('Polyglot')) return 'Polyglot';
  if (name.includes('Wavenet') || name.includes('WaveNet')) return 'WaveNet';
  // Old-style Standard voices follow the pattern: en-XX-Standard-X
  if (name.includes('Standard')) return 'Standard';
  // New-gen voices use single names (Achernar, Puck, Kore, etc.) — no tier prefix
  return 'Next Gen';
}

export default router;
