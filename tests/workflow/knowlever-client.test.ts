import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createKnowLeverClient, type KnowLeverClient } from '../../src/workflow/knowlever-client.js';

describe('KnowLeverClient', () => {
  const baseUrl = 'http://localhost:9876';
  let client: KnowLeverClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = createKnowLeverClient({ baseUrl });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('search', () => {
    it('should call /api/search with query', async () => {
      const mockResponse = {
        results: [
          { content: 'test result', source: 'wiki', score: 0.95 },
        ],
        total: 1,
      };
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      } as Response);

      const result = await client.search('test query');
      expect(result.total).toBe(1);
      expect(result.results[0].content).toBe('test result');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://localhost:9876/api/search');
      const body = JSON.parse(opts.body as string);
      expect(body.query).toBe('test query');
    });

    it('should pass topK and userId when provided', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ results: [], total: 0 }),
      } as Response);

      await client.search('q', 5, 'user1');
      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body as string);
      expect(body.top_k).toBe(5);
      expect(body.user_id).toBe('user1');
    });

    it('should throw on non-OK response', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      } as Response);

      await expect(client.search('fail')).rejects.toThrow('returned 500');
    });
  });

  describe('ingest', () => {
    it('should call /api/ingest with documents', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ingested: 2 }),
      } as Response);

      const docs = [
        { content: 'doc1', metadata: { source: 'a' } },
        { content: 'doc2', metadata: { source: 'b' } },
      ];
      const result = await client.ingest(docs);
      expect(result.ingested).toBe(2);
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://localhost:9876/api/ingest');
    });
  });

  describe('compile', () => {
    it('should call /api/compile with topic', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ compiled: 3, wiki_pages: 5 }),
      } as Response);

      const result = await client.compile('typescript', 'user1');
      expect(result.compiled).toBe(3);
      expect(result.wiki_pages).toBe(5);
      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body as string);
      expect(body.topic).toBe('typescript');
      expect(body.user_id).toBe('user1');
    });
  });

  describe('timeout', () => {
    it('should strip trailing slashes from baseUrl', () => {
      const c = createKnowLeverClient({ baseUrl: 'http://host:1234/' });
      // We verify by checking that a search call uses the correct URL
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ results: [], total: 0 }),
      } as Response);
      c.search('x');
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://host:1234/api/search');
    });
  });
});

import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createFourLayerMemoryManager,
  deduplicateKnowLeverResults,
  type FourLayerMemoryConfig,
} from '../../src/workflow/four-layer-memory.js';
import { clearViolations } from '../../src/workflow/clean-memory-clause.js';
import { fetchKnowledgeEnrichment, type WorkflowCompilerConfig } from '../../src/workflow/compiler.js';
import type { KnowLeverSearchResult } from '../../src/workflow/knowlever-client.js';
import type { Block } from '../../src/workflow/types.js';

describe('KnowLever + FourLayerMemoryManager integration', () => {
  let tmpDir: string;
  let scratchDir: string;
  let soulPath: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `kl-flm-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    scratchDir = join(tmpDir, 'scratch');
    soulPath = join(tmpDir, 'PolarSoul.md');
    writeFileSync(soulPath, '# Test Soul');
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    clearViolations();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  function mockKnowLeverClient(): KnowLeverClient {
    return {
      search: vi.fn().mockResolvedValue({
        results: [
          { content: 'KnowLever result 1', source: 'wiki-a', score: 0.9 },
          { content: 'KnowLever result 2', source: 'wiki-b', score: 0.8 },
        ],
        total: 2,
      }),
      ingest: vi.fn().mockResolvedValue({ ingested: 1 }),
      compile: vi.fn().mockResolvedValue({ compiled: 1, wiki_pages: 2 }),
    };
  }

  it('should include KnowLever results in getLongTermLayer', async () => {
    const klClient = mockKnowLeverClient();
    const config: FourLayerMemoryConfig = {
      soulPath,
      workflowPath: join(tmpDir, 'workflow.md'),
      scratchDir,
      knowleverClient: klClient,
    };
    const mm = createFourLayerMemoryManager(config);
    const lt = await mm.getLongTermLayer('test query');
    expect(lt.knowleverResults).toBeDefined();
    expect(lt.knowleverResults!.length).toBe(2);
    expect(lt.knowleverResults![0].content).toBe('KnowLever result 1');
    expect(lt.total).toBe(2); // 0 blocks + 2 KnowLever
  });

  it('should work without KnowLever client (backward compatible)', async () => {
    const config: FourLayerMemoryConfig = {
      soulPath,
      workflowPath: join(tmpDir, 'workflow.md'),
      scratchDir,
    };
    const mm = createFourLayerMemoryManager(config);
    const lt = await mm.getLongTermLayer('test');
    expect(lt.knowleverResults).toBeUndefined();
    expect(lt.blocks).toEqual([]);
  });

  it('should include KnowLever results in buildFullContext', async () => {
    const klClient = mockKnowLeverClient();
    const config: FourLayerMemoryConfig = {
      soulPath,
      workflowPath: join(tmpDir, 'workflow.md'),
      scratchDir,
      knowleverClient: klClient,
    };
    const mm = createFourLayerMemoryManager(config);
    const ctx = await mm.buildFullContext('test');
    expect(ctx).toContain('KnowLever RAG');
    expect(ctx).toContain('KnowLever result 1');
  });

  it('should handle KnowLever errors gracefully', async () => {
    const klClient: KnowLeverClient = {
      search: vi.fn().mockRejectedValue(new Error('connection refused')),
      ingest: vi.fn(),
      compile: vi.fn(),
    };
    const config: FourLayerMemoryConfig = {
      soulPath,
      workflowPath: join(tmpDir, 'workflow.md'),
      scratchDir,
      knowleverClient: klClient,
    };
    const mm = createFourLayerMemoryManager(config);
    const lt = await mm.getLongTermLayer('test');
    expect(lt.knowleverResults).toBeUndefined();
    expect(lt.blocks).toEqual([]);
  });
});

describe('deduplicateKnowLeverResults', () => {
  it('should remove KnowLever results similar to existing blocks', () => {
    const blocks: Block[] = [
      {
        label: 'test',
        value: 'The quick brown fox jumps over the lazy dog',
        tokens: 10,
        read_only: true,
        source_wiki: 'wiki',
        created_at: '',
        updated_at: '',
      },
    ];
    const results: KnowLeverSearchResult[] = [
      { content: 'The quick brown fox jumps over the lazy dog', source: 'kl', score: 0.9 },
      { content: 'Completely different content about TypeScript', source: 'kl', score: 0.8 },
    ];
    const deduped = deduplicateKnowLeverResults(blocks, results);
    expect(deduped.length).toBe(1);
    expect(deduped[0].content).toContain('TypeScript');
  });

  it('should keep all results when no blocks exist', () => {
    const results: KnowLeverSearchResult[] = [
      { content: 'result 1', source: 'kl', score: 0.9 },
      { content: 'result 2', source: 'kl', score: 0.8 },
    ];
    const deduped = deduplicateKnowLeverResults([], results);
    expect(deduped.length).toBe(2);
  });

  it('should keep all results when content is dissimilar', () => {
    const blocks: Block[] = [
      {
        label: 'a',
        value: 'Python web framework Django REST API',
        tokens: 8,
        read_only: false,
        source_wiki: 'w',
        created_at: '',
        updated_at: '',
      },
    ];
    const results: KnowLeverSearchResult[] = [
      { content: 'TypeScript compiler options strict mode', source: 'kl', score: 0.9 },
    ];
    const deduped = deduplicateKnowLeverResults(blocks, results);
    expect(deduped.length).toBe(1);
  });
});

describe('fetchKnowledgeEnrichment', () => {
  it('should return empty string when enrichment is disabled', async () => {
    const result = await fetchKnowledgeEnrichment('test');
    expect(result).toBe('');
  });

  it('should return empty string when no client is provided', async () => {
    const config: WorkflowCompilerConfig = { enableKnowledgeEnrichment: true };
    const result = await fetchKnowledgeEnrichment('test', config);
    expect(result).toBe('');
  });

  it('should return formatted enrichment when client is available', async () => {
    const klClient: KnowLeverClient = {
      search: vi.fn().mockResolvedValue({
        results: [
          { content: 'enriched knowledge', source: 'wiki', score: 0.95 },
        ],
        total: 1,
      }),
      ingest: vi.fn(),
      compile: vi.fn(),
    };
    const config: WorkflowCompilerConfig = {
      enableKnowledgeEnrichment: true,
      knowleverClient: klClient,
    };
    const result = await fetchKnowledgeEnrichment('test query', config);
    expect(result).toContain('Knowledge Enrichment');
    expect(result).toContain('enriched knowledge');
    expect(result).toContain('0.950');
  });

  it('should return empty string on client error', async () => {
    const klClient: KnowLeverClient = {
      search: vi.fn().mockRejectedValue(new Error('fail')),
      ingest: vi.fn(),
      compile: vi.fn(),
    };
    const config: WorkflowCompilerConfig = {
      enableKnowledgeEnrichment: true,
      knowleverClient: klClient,
    };
    const result = await fetchKnowledgeEnrichment('test', config);
    expect(result).toBe('');
  });

  it('should return empty string when search returns no results', async () => {
    const klClient: KnowLeverClient = {
      search: vi.fn().mockResolvedValue({ results: [], total: 0 }),
      ingest: vi.fn(),
      compile: vi.fn(),
    };
    const config: WorkflowCompilerConfig = {
      enableKnowledgeEnrichment: true,
      knowleverClient: klClient,
    };
    const result = await fetchKnowledgeEnrichment('test', config);
    expect(result).toBe('');
  });
});
