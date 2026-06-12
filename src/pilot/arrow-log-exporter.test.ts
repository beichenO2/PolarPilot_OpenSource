import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTargetStore } from './targets';
import { createArrowLogExporter, extractArrowLogs } from './arrow-log-exporter';
import type { ArrowLog, Target } from './types';

let tmpDir: string;
let store: ReturnType<typeof createTargetStore>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'arrow-log-test-'));
  store = createTargetStore({ targetsDir: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('extractArrowLogs', () => {
  it('returns empty array for empty store', () => {
    const logs = extractArrowLogs(store, 'test-project');
    expect(logs).toEqual([]);
  });

  it('extracts arrow_logs from single target', () => {
    store.create({ id: 'root-1', type: 'root_target', title: 'Root', description: 'desc' });
    store.create({ id: 'leaf-1', type: 'test_target', title: 'Leaf', description: 'desc', parent_id: 'root-1' });

    const arrowLog: ArrowLog = {
      ts: '2026-05-10T10:00:00Z',
      outcome: 'hit',
      delta: '修改了 src/utils.ts 的 helper 函数',
      next_action: 'shoot',
    };
    store.appendArrowLog('leaf-1', arrowLog);

    const logs = extractArrowLogs(store, 'test-project');
    expect(logs.length).toBe(1);
    expect(logs[0]).toEqual({
      project_id: 'test-project',
      target_id: 'leaf-1',
      ts: '2026-05-10T10:00:00Z',
      outcome: 'hit',
      delta: '修改了 src/utils.ts 的 helper 函数',
      next_action: 'shoot',
    });
  });

  it('extracts arrow_logs from multiple targets', () => {
    store.create({ id: 'root-1', type: 'root_target', title: 'Root', description: 'desc' });
    store.create({ id: 'leaf-1', type: 'test_target', title: 'Leaf 1', description: 'desc', parent_id: 'root-1' });
    store.create({ id: 'leaf-2', type: 'test_target', title: 'Leaf 2', description: 'desc', parent_id: 'root-1' });

    store.appendArrowLog('leaf-1', { ts: '2026-05-10T10:00:00Z', outcome: 'hit', delta: 'delta 1', next_action: 'shoot' });
    store.appendArrowLog('leaf-2', { ts: '2026-05-10T10:01:00Z', outcome: 'miss', delta: 'delta 2', next_action: 'moveboard' });

    const logs = extractArrowLogs(store, 'my-project');
    expect(logs.length).toBe(2);
    expect(logs.find(l => l.target_id === 'leaf-1')).toBeDefined();
    expect(logs.find(l => l.target_id === 'leaf-2')).toBeDefined();
  });

  it('sorts logs by timestamp', () => {
    store.create({ id: 'root-1', type: 'root_target', title: 'Root', description: 'desc' });
    store.create({ id: 'leaf-1', type: 'test_target', title: 'Leaf', description: 'desc', parent_id: 'root-1' });

    store.appendArrowLog('leaf-1', { ts: '2026-05-10T10:02:00Z', outcome: 'hit', delta: 'later', next_action: 'shoot' });
    store.appendArrowLog('leaf-1', { ts: '2026-05-10T10:00:00Z', outcome: 'miss', delta: 'earlier', next_action: 'shoot' });

    const logs = extractArrowLogs(store, 'test');
    expect(logs.length).toBe(2);
    expect(logs[0]!.ts).toBe('2026-05-10T10:00:00Z');
    expect(logs[1]!.ts).toBe('2026-05-10T10:02:00Z');
  });
});

describe('createArrowLogExporter', () => {
  it('exportAll returns all arrow_logs', () => {
    store.create({ id: 'root-1', type: 'root_target', title: 'Root', description: 'desc' });
    store.create({ id: 'leaf-1', type: 'test_target', title: 'Leaf', description: 'desc', parent_id: 'root-1' });

    store.appendArrowLog('leaf-1', { ts: '2026-05-10T10:00:00Z', outcome: 'hit', delta: 'test delta', next_action: 'shoot' });

    const exporter = createArrowLogExporter({ projectId: 'test-project' });
    const logs = exporter.exportAll(store);

    expect(logs.length).toBe(1);
    expect(logs[0]!.project_id).toBe('test-project');
  });

  it('send returns success for empty logs', async () => {
    const exporter = createArrowLogExporter({ projectId: 'test-project' });
    const result = await exporter.send([]);
    expect(result.success).toBe(true);
    expect(result.received).toBe(0);
  });

  it('send uses custom sender when provided', async () => {
    const mockSender = vi.fn().mockResolvedValue({ success: true, received: 2 });

    const exporter = createArrowLogExporter({
      projectId: 'test-project',
      sender: mockSender,
    });

    const logs = [
      { project_id: 'test-project', target_id: 't1', ts: '2026-05-10T10:00:00Z', outcome: 'hit' as const, delta: 'd1', next_action: 'shoot' as const },
      { project_id: 'test-project', target_id: 't2', ts: '2026-05-10T10:01:00Z', outcome: 'miss' as const, delta: 'd2', next_action: 'moveboard' as const },
    ];

    const result = await exporter.send(logs);
    expect(mockSender).toHaveBeenCalledWith(logs);
    expect(result.success).toBe(true);
    expect(result.received).toBe(2);
  });

  it('exportAndSend combines export and send', async () => {
    store.create({ id: 'root-1', type: 'root_target', title: 'Root', description: 'desc' });
    store.create({ id: 'leaf-1', type: 'test_target', title: 'Leaf', description: 'desc', parent_id: 'root-1' });
    store.appendArrowLog('leaf-1', { ts: '2026-05-10T10:00:00Z', outcome: 'hit', delta: 'test', next_action: 'shoot' });

    const mockSender = vi.fn().mockResolvedValue({ success: true, received: 1 });

    const exporter = createArrowLogExporter({
      projectId: 'test-project',
      sender: mockSender,
    });

    const result = await exporter.exportAndSend(store);
    expect(result.success).toBe(true);
    expect(result.sent).toBe(1);
  });
});
