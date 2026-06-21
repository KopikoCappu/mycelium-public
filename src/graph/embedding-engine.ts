/**
 * Mycelium Embedding Engine
 * Semantic vector search using OpenAI text-embedding-3-small.
 * Embeddings cached in .mycelium/embeddings.json by content hash.
 * Falls back gracefully to keyword search if no key is configured.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

interface EmbeddingRecord {
  nodeId: string;
  hash: string;
  vector: number[];
  text: string;
}

interface EmbeddingStore {
  version: number;
  records: Record<string, EmbeddingRecord>;  // hash → record
  nodeIndex: Record<string, string>;         // nodeId → hash
}

export interface SearchHit {
  nodeId: string;
  score: number;
  text: string;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class EmbeddingEngine {
  private store: EmbeddingStore;
  private storePath: string;
  private apiKey: string | null;
  private dirty = false;

  constructor(myceliumDir: string, openAiKey?: string) {
    this.storePath = path.join(myceliumDir, 'embeddings.json');
    this.apiKey = openAiKey ?? null;
    this.store = this.load();
  }

  private load(): EmbeddingStore {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        if (raw.version === 1) return raw;
      }
    } catch { /* corrupt, start fresh */ }
    return { version: 1, records: {}, nodeIndex: {} };
  }

  save(): void {
    if (!this.dirty) return;
    fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2));
    this.dirty = false;
  }

  isReady(): boolean {
    return this.apiKey !== null && Object.keys(this.store.nodeIndex).length > 0;
  }

  stats() {
    return {
      totalEmbedded: Object.keys(this.store.nodeIndex).length,
      hasApiKey: this.apiKey !== null,
    };
  }

  // ─── Build embed text ────────────────────────────────────────────────────

  static buildText(node: {
    id: string;
    name?: string;
    description?: string;
    tags?: string[];
    kind?: string;
  }): string {
    const parts: string[] = [];
    if (node.kind) parts.push(`[${node.kind}]`);
    if (node.name) parts.push(node.name);
    if (node.tags?.length) parts.push(node.tags.join(' '));
    if (node.description) parts.push(node.description);
    return parts.join(' | ').slice(0, 8000);
  }

  // ─── Cache check ─────────────────────────────────────────────────────────

  private hash(nodeId: string, text: string): string {
    return crypto.createHash('sha256')
      .update(nodeId + '\x00' + text)
      .digest('hex').slice(0, 16);
  }

  needsEmbedding(nodeId: string, text: string): boolean {
    const h = this.hash(nodeId, text);
    return this.store.nodeIndex[nodeId] !== h || !this.store.records[h];
  }

  // ─── Embed batch ─────────────────────────────────────────────────────────

  async embedNodes(
    nodes: Array<{ id: string; text: string }>,
    onProgress?: (done: number, total: number) => void
  ): Promise<number> {
    if (!this.apiKey) throw new Error('No OpenAI key. Run: mycelium key --openai <key>');

    const pending = nodes.filter(n => this.needsEmbedding(n.id, n.text));
    if (pending.length === 0) return 0;

    const BATCH = 100;
    let done = 0;

    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      const response = await this.callOpenAI(batch.map(n => n.text));

      for (let j = 0; j < batch.length; j++) {
        const { id, text } = batch[j];
        const vector = response[j];
        const h = this.hash(id, text);
        this.store.records[h] = { nodeId: id, hash: h, vector, text };
        this.store.nodeIndex[id] = h;
        this.dirty = true;
      }

      done += batch.length;
      onProgress?.(done, pending.length);
    }

    this.save();
    return pending.length;
  }

  // ─── Search ──────────────────────────────────────────────────────────────

  async search(query: string, topK = 10, minScore = 0.3): Promise<SearchHit[]> {
    if (!this.apiKey) throw new Error('No OpenAI key configured');
    const [queryVec] = await this.callOpenAI([query]);
    return this.scoreAll(queryVec, topK, minScore);
  }

  async expandedSearch(queries: string[], topK = 10, minScore = 0.25): Promise<SearchHit[]> {
    if (!this.apiKey) throw new Error('No OpenAI key configured');
    const vecs = await this.callOpenAI(queries);
    const hitMap = new Map<string, SearchHit>();

    for (const qvec of vecs) {
      for (const hit of this.scoreAll(qvec, topK * 2, minScore)) {
        const existing = hitMap.get(hit.nodeId);
        if (!existing || existing.score < hit.score) hitMap.set(hit.nodeId, hit);
      }
    }

    return Array.from(hitMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  findSimilarNodes(nodeId: string, topK = 10, minScore = 0.3): SearchHit[] {
    const h = this.store.nodeIndex[nodeId];
    if (!h) return [];
    const vec = this.store.records[h]?.vector;
    if (!vec) return [];

    return this.scoreAll(vec, topK + 1, minScore)
      .filter(hit => hit.nodeId !== nodeId)
      .slice(0, topK);
  }

  pruneOrphans(existingNodeIds: Set<string>): number {
    let pruned = 0;
    for (const nodeId of Object.keys(this.store.nodeIndex)) {
      if (!existingNodeIds.has(nodeId)) {
        const h = this.store.nodeIndex[nodeId];
        delete this.store.nodeIndex[nodeId];
        delete this.store.records[h];
        pruned++;
        this.dirty = true;
      }
    }
    if (this.dirty) this.save();
    return pruned;
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private scoreAll(queryVec: number[], topK: number, minScore: number): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const [nodeId, h] of Object.entries(this.store.nodeIndex)) {
      const rec = this.store.records[h];
      if (!rec) continue;
      const score = cosine(queryVec, rec.vector);
      if (score >= minScore) hits.push({ nodeId, score, text: rec.text });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  private async callOpenAI(inputs: string[]): Promise<number[][]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: inputs,
        encoding_format: 'float',
      }),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => 'unknown error');
      throw new Error(`OpenAI embedding API error ${response.status}: ${err.slice(0, 200)}`);
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    return data.data.map(d => d.embedding);
  }
}

// ─── Query expansion ──────────────────────────────────────────────────────────

const EXPANSIONS: Record<string, string[]> = {
  auth: ['authentication', 'login', 'session', 'token', 'jwt', 'oauth'],
  login: ['signin', 'authenticate', 'credentials', 'auth'],
  db: ['database', 'query', 'sql', 'orm', 'repository'],
  api: ['endpoint', 'route', 'controller', 'handler', 'request'],
  user: ['account', 'profile', 'member', 'customer'],
  payment: ['billing', 'stripe', 'checkout', 'invoice', 'subscription'],
  test: ['spec', 'unit', 'integration', 'mock', 'fixture'],
  config: ['settings', 'environment', 'env', 'options'],
  cache: ['redis', 'store', 'invalidate', 'ttl'],
  email: ['mail', 'smtp', 'notification', 'send'],
  component: ['widget', 'element', 'view', 'render', 'ui'],
  hook: ['effect', 'callback', 'lifecycle', 'react'],
};

export function expandQuery(query: string): string[] {
  const q = query.toLowerCase();
  const queries = [query];
  for (const [term, related] of Object.entries(EXPANSIONS)) {
    if (q.includes(term)) {
      queries.push(...related.slice(0, 2).map(r => `${query} ${r}`));
    }
  }
  return [...new Set(queries)].slice(0, 5);
}

// ─── Math ─────────────────────────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Global engine instance (initialized in cli.ts) ──────────────────────────

let _engine: EmbeddingEngine | null = null;

export function initEngine(myceliumDir: string, openAiKey?: string): EmbeddingEngine {
  _engine = new EmbeddingEngine(myceliumDir, openAiKey);
  return _engine;
}

export function getEngine(): EmbeddingEngine | null {
  return _engine;
}
