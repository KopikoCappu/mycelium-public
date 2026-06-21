import type { GraphNode } from '../graph/schema';
import type { GraphStore } from '../graph/store';

// ─── Summarizer ───────────────────────────────────────────────────────────────
// Takes file nodes with empty descriptions and batches them to Claude Haiku.
// Each response includes: 1-2 sentence intent description + tag array.

export interface SummarizerConfig {
  model: string;
  batchSize: number;
  apiKey?: string;
}

interface SummarizeResponse {
  nodeId: string;
  description: string;
  tags: string[];
}

export class Summarizer {
  private config: SummarizerConfig;

  constructor(config: SummarizerConfig) {
    this.config = config;
  }

  // ── Public: process all pending nodes in the store ────────────────────────

  async summarizePending(store: GraphStore, getFileContent: (path: string) => string | null): Promise<void> {
    const pending = store.getPendingSummarization(200);
    if (pending.length === 0) return;

    console.log(`[GraphMem] Summarizing ${pending.length} files...`);

    // Process in batches to avoid overwhelming the API
    for (let i = 0; i < pending.length; i += this.config.batchSize) {
      const batch = pending.slice(i, i + this.config.batchSize);
      const results = await this.summarizeBatch(batch, getFileContent);

      for (const result of results) {
        store.updateDescription(result.nodeId, result.description, result.tags);
      }
    }
  }

  // ── Batch summarization call ──────────────────────────────────────────────

  private async summarizeBatch(
    nodes: GraphNode[],
    getFileContent: (path: string) => string | null
  ): Promise<SummarizeResponse[]> {
    const fileSections = nodes.map(node => {
      const content = getFileContent(node.path);
      if (!content) return null;

      // Truncate large files -- send first 200 lines, enough for intent
      const truncated = content.split('\n').slice(0, 200).join('\n');
      return { nodeId: node.id, path: node.path, content: truncated };
    }).filter(Boolean) as Array<{ nodeId: string; path: string; content: string }>;

    if (fileSections.length === 0) return [];

    const prompt = buildSummaryPrompt(fileSections);

    try {
      const apiKey = this.config.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('No ANTHROPIC_API_KEY found');

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        // Log full error locally but don't expose raw API response body externally
        console.error('[Mycelium] Anthropic API error body:', errText.slice(0, 500));
        throw new Error(`Anthropic API error: HTTP ${response.status}`);
      }

      const data = await response.json() as any;
      const text = data.content?.[0]?.text || '';
      return parseSummaryResponse(text, fileSections.map(f => f.nodeId));
    } catch (err) {
      console.error('[GraphMem] Summarization error:', err);
      // Return empty descriptions so we don't get stuck in a loop
      return fileSections.map(f => ({ nodeId: f.nodeId, description: '', tags: [] }));
    }
  }
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildSummaryPrompt(files: Array<{ nodeId: string; path: string; content: string }>): string {
  const fileBlocks = files.map((f, i) =>
    `<file index="${i}" id="${f.nodeId}" path="${f.path}">
${f.content}
</file>`
  ).join('\n\n');

  return `You are analyzing source code files to generate structured memory for AI coding agents.

For each file below, produce:
1. A 1–2 sentence DESCRIPTION of what the file does and its purpose in the codebase. Be specific and concrete -- mention key exports, patterns, or data flows. Write for an AI agent that needs to decide "should I read this file?"
2. A list of TAGS (3–8 lowercase keywords) covering: domain (auth, billing, ui, api, db), technology (firebase, stripe, react, graphql), and role (hooks, utils, types, middleware, components, store).

Respond ONLY with a JSON array, no markdown, no preamble:
[
  {
    "id": "<node id from the file tag>",
    "description": "...",
    "tags": ["tag1", "tag2", ...]
  },
  ...
]

FILES:
${fileBlocks}`;
}

// ─── Response parser ──────────────────────────────────────────────────────────

function parseSummaryResponse(text: string, expectedIds: string[]): SummarizeResponse[] {
  const clean = text.replace(/```json|```/g, '').trim();
  try {
    const parsed = JSON.parse(clean) as Array<{ id: string; description: string; tags: string[] }>;
    return parsed.map(item => ({
      nodeId: item.id,
      description: item.description || '',
      tags: Array.isArray(item.tags) ? item.tags : [],
    }));
  } catch {
    // Fallback: return empty results for expected IDs
    console.error('[GraphMem] Failed to parse summarization response:', text.slice(0, 200));
    return expectedIds.map(id => ({ nodeId: id, description: '', tags: [] }));
  }
}
