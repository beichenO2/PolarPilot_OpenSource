// ── KnowLever RAG client adapter ──────────────────────────────────
//
// Thin HTTP wrapper around the KnowLever knowledge API. All methods are
// optional — PolarPilot works fine without a KnowLever instance.

export interface KnowLeverSearchResult {
  content: string;
  source: string;
  score: number;
}

export interface KnowLeverSearchResponse {
  results: KnowLeverSearchResult[];
  total: number;
}

export interface KnowLeverIngestDocument {
  content: string;
  metadata: Record<string, unknown>;
}

export interface KnowLeverIngestResponse {
  ingested: number;
}

export interface KnowLeverCompileResponse {
  compiled: number;
  wiki_pages: number;
}

export interface KnowLeverClient {
  /** Search the KnowLever RAG index. */
  search(query: string, topK?: number, userId?: string): Promise<KnowLeverSearchResponse>;

  /** Ingest documents into the knowledge base. */
  ingest(documents: KnowLeverIngestDocument[]): Promise<KnowLeverIngestResponse>;

  /** Trigger knowledge compilation for a topic. */
  compile(topic: string, userId?: string): Promise<KnowLeverCompileResponse>;
}

export interface KnowLeverClientConfig {
  baseUrl: string;
  /** Request timeout in milliseconds (default: 10 000). */
  timeout?: number;
}

export function createKnowLeverClient(config: KnowLeverClientConfig): KnowLeverClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const timeout = config.timeout ?? 10_000;

  async function request<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const resp = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`KnowLever ${path} returned ${resp.status}`);
      }
      return (await resp.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async search(query, topK, userId) {
      const body: Record<string, unknown> = { query };
      if (topK !== undefined) body.top_k = topK;
      if (userId !== undefined) body.user_id = userId;
      return request<KnowLeverSearchResponse>('/api/search', body);
    },

    async ingest(documents) {
      return request<KnowLeverIngestResponse>('/api/ingest', { documents });
    },

    async compile(topic, userId) {
      const body: Record<string, unknown> = { topic };
      if (userId !== undefined) body.user_id = userId;
      return request<KnowLeverCompileResponse>('/api/compile', body);
    },
  };
}
