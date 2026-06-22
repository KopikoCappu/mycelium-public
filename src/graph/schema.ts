// ─── Node Types ───────────────────────────────────────────────────────────────

export type NodeKind = 'file' | 'function' | 'class' | 'type' | 'constant' | 'interface' | 'cluster';

export interface GraphNode {
  id: string;            // unique: "src/auth/TokenManager.ts" or "src/auth/TokenManager.ts::TokenManager"
  kind: NodeKind;
  path: string;          // file path (same as id for file nodes)
  name: string;          // display name: "TokenManager.ts" or "TokenManager"
  description: string;   // AI-generated 1–2 sentence intent
  signature?: string;    // for functions/classes: "function refreshToken(uid: string): Promise<Token | null>"
  tags: string[];        // AI-inferred: ["auth", "firebase", "tokens"]
  exported: boolean;     // is this symbol exported?
  lineStart?: number;
  lineEnd?: number;
  lastHash: string;      // SHA256 of file content at time of parse
  lastUpdated: number;   // unix timestamp
  lineCount?: number;
}

// ─── Edge Types ───────────────────────────────────────────────────────────────

export type EdgeKind =
  | 'imports'       // file A imports from file B
  | 'calls'         // function A calls function B
  | 'extends'       // class A extends class B
  | 'implements'    // class A implements interface B
  | 'uses-type'     // function A uses type B in its signature
  | 'exports'       // file exports symbol
  | 'cluster';      // symbol belongs to feature cluster

export interface GraphEdge {
  id: string;        // `${from}::${kind}::${to}`
  from: string;      // node id
  to: string;        // node id
  kind: EdgeKind;
  weight: number;    // call frequency / import count, for ranking relevance
}

// ─── Cluster (AI-inferred feature group) ──────────────────────────────────────

export interface GraphCluster {
  id: string;
  name: string;         // "Authentication Flow", "Pod Invitation System"
  description: string;  // AI summary of the cluster's purpose
  nodeIds: string[];
  tags: string[];
}

// ─── Team Lens ────────────────────────────────────────────────────────────────

export interface TeamLens {
  name: string;
  includeTags: string[];      // nodes whose tags overlap these are included
  excludeTags?: string[];
  includeAll?: boolean;       // "core" team -- sees everything
  includeGlobs?: string[];    // e.g. ["src/security/**", "src/auth/**"] as hard overrides
}

// ─── Config (from .graphmem/config.json) ─────────────────────────────────────

export interface GraphMemConfig {
  teams: Record<string, TeamLens>;
  summarizer: {
    model: string;            // "claude-haiku-4-5" by default
    batchSize: number;
    apiKey?: string;          // falls back to ANTHROPIC_API_KEY env
  };
  parser: {
    include: string[];        // glob patterns: ["src/**/*.ts", "src/**/*.tsx"]
    exclude: string[];        // ["node_modules/**", "dist/**", "**/*.test.ts"]
  };
  mcp: {
    port: number;             // default 47821
    enabled: boolean;
  };
}

export const DEFAULT_CONFIG: GraphMemConfig = {
  teams: {
    core: { name: 'core', includeTags: [], includeAll: true },
  },
  summarizer: {
    model: 'claude-haiku-4-5',
    batchSize: 10,
  },
  parser: {
    include: ['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.js', 'src/**/*.jsx'],
    exclude: ['node_modules/**', 'dist/**', '.graphmem/**', '**/*.test.*', '**/*.spec.*'],
  },
  mcp: {
    port: 47821,
    enabled: true,
  },
};

// ─── Graph query types (used by MCP server) ───────────────────────────────────

export interface NodeSummary {
  id: string;
  kind: NodeKind;
  name: string;
  description: string;
  tags: string[];
  path: string;
}

export interface SubGraph {
  nodes: NodeSummary[];
  edges: Array<{ from: string; to: string; kind: EdgeKind }>;
  totalNodes: number;
  filteredBy?: string;  // team name if scoped
}

export interface DependencyMap {
  target: NodeSummary;
  dependsOn: NodeSummary[];   // what this node imports/uses
  usedBy: NodeSummary[];      // what imports/calls this node
}
