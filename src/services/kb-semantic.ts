// Semantic KB search over the obsidian-mcp-server's embedding cache.
//
// Strictly read-only consumer of each vault's .embedding-cache/embeddings.json
// (written by the MCP server's precompute pass) — the bridge never writes to
// the cache; the MCP server is the single writer. Query embedding happens
// in-process with the same model the MCP server used to build the cache, so
// cosine similarity between query and document vectors is meaningful.

import fs from 'fs';
import path from 'path';
import { getObsidianRoot, getObsidianVaults } from '../config';

// One entry of embeddings.json on disk: file is vault-relative.
interface CacheEntry {
  file: string;
  embedding: number[];
  timestamp: number;
}

interface DocEmbedding {
  path: string; // absolute
  embedding: number[];
}

// In-memory copy per cache file, invalidated on mtime change so an MCP-side
// re-embed pass is picked up without restarting the bridge.
const vaultCaches = new Map<string, { mtimeMs: number; docs: DocEmbedding[] }>();

function loadAllEmbeddings(vaultNames: string[]): DocEmbedding[] {
  const root = getObsidianRoot();
  const docs: DocEmbedding[] = [];
  for (const vault of vaultNames) {
    const vaultDir = path.join(root, vault);
    const cacheFile = path.join(vaultDir, '.embedding-cache', 'embeddings.json');
    let stat;
    try {
      stat = fs.statSync(cacheFile);
    } catch {
      continue; // vault has no embedding cache
    }
    const cached = vaultCaches.get(cacheFile);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      docs.push(...cached.docs);
      continue;
    }
    try {
      const entries = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as CacheEntry[];
      const vaultDocs: DocEmbedding[] = [];
      for (const e of entries) {
        if (!e.file || !Array.isArray(e.embedding) || e.embedding.length === 0) continue;
        vaultDocs.push({ path: path.join(vaultDir, e.file), embedding: e.embedding });
      }
      vaultCaches.set(cacheFile, { mtimeMs: stat.mtimeMs, docs: vaultDocs });
      docs.push(...vaultDocs);
    } catch {
      // Likely a partial write by the MCP server mid-save; keep the previous
      // good copy if we have one and try again on the next search.
      if (cached) docs.push(...cached.docs);
    }
  }
  return docs;
}

// Must match the model the MCP server uses to build the cache.
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

let extractorPromise: Promise<any> | null = null;

// @xenova/transformers is ESM-only and this project compiles to CommonJS,
// where tsc down-levels import() to require(). new Function keeps it a real
// dynamic import at runtime.
const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

function getExtractor(): Promise<any> {
  if (!extractorPromise) {
    extractorPromise = dynamicImport('@xenova/transformers')
      .then(({ pipeline }) => pipeline('feature-extraction', MODEL_NAME))
      .catch(err => {
        extractorPromise = null; // allow retry on the next request
        throw err;
      });
  }
  return extractorPromise;
}

async function embedQuery(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const result = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data as number[]);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export async function semanticSearch(
  query: string,
  limit: number,
  vaultNames: string[] = getObsidianVaults()
): Promise<{ available: boolean; results: { path: string; score: number }[] }> {
  const docs = loadAllEmbeddings(vaultNames);
  if (docs.length === 0) return { available: false, results: [] };

  const queryVec = await embedQuery(query);
  const scored = docs
    .map(d => ({ path: d.path, score: cosineSimilarity(queryVec, d.embedding) }))
    .sort((a, b) => b.score - a.score);

  // Cache entries can outlive their files — only return docs that still exist.
  const results: { path: string; score: number }[] = [];
  for (const s of scored) {
    if (results.length >= limit) break;
    if (fs.existsSync(s.path)) results.push(s);
  }
  return { available: true, results };
}
