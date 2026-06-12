import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTargetDiscovery, type CandidateTarget, type TargetDiscoveryConfig } from './discovery.js';
import { createTargetStore, type TargetStore } from './targets.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('TargetDiscovery', () => {
  let tempDir: string;
  let projectDir: string;
  let targetStore: TargetStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'discovery-test-'));
    projectDir = join(tempDir, 'test-project');
    mkdirSync(projectDir, { recursive: true });
    targetStore = createTargetStore({ targetsDir: join(tempDir, 'targets') });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('createTargetDiscovery', () => {
    it('should discover candidates from project status', async () => {
      // Create polaris.json with incomplete requirement
      writeFileSync(join(projectDir, 'polaris.json'), JSON.stringify({
        name: 'test-project',
        requirements: [
          { id: 'req-1', status: 'pending' },
          { id: 'req-2', status: 'completed' },
        ],
        features: [
          { id: 'feat-1', test_status: 'failed' },
        ],
      }));

      const discovery = createTargetDiscovery({
        polarisPath: projectDir,
      });

      const candidates = await discovery.discover('test-project');

      expect(candidates.length).toBeGreaterThan(0);
      // Should find incomplete requirement and failed feature
      const titles = candidates.map(c => c.title);
      expect(titles.some(t => t.includes('req-1'))).toBe(true);
      expect(titles.some(t => t.includes('feat-1'))).toBe(true);
    });

    it('should discover candidates from arrow_logs', async () => {
      const logs = [
        { project_id: 'test', target_id: 't1', ts: new Date().toISOString(), outcome: 'miss' as const, delta: 'Failed to compile', next_action: 'shoot' as const },
        { project_id: 'test', target_id: 't1', ts: new Date().toISOString(), outcome: 'miss' as const, delta: 'Failed to compile', next_action: 'shoot' as const },
        { project_id: 'test', target_id: 't1', ts: new Date().toISOString(), outcome: 'miss' as const, delta: 'Failed to compile', next_action: 'shoot' as const },
      ];

      const discovery = createTargetDiscovery({
        polarisPath: projectDir,
        arrowLogExporter: { exportAll: () => logs },
      });

      const candidates = await discovery.discover('test');

      // Should find repeated miss pattern
      expect(candidates.some(c => c.title.includes('t1'))).toBe(true);
    });

    it('should return empty array when no polaris.json', async () => {
      const discovery = createTargetDiscovery({
        polarisPath: projectDir, // No polaris.json
      });

      const candidates = await discovery.discover('test-project');

      expect(candidates.length).toBe(0);
    });

    it('should analyze project status correctly', () => {
      writeFileSync(join(projectDir, 'polaris.json'), JSON.stringify({
        name: 'test-project',
        requirements: [
          { id: 'req-1', status: 'pending' },
          { id: 'req-2', status: 'completed' },
        ],
        features: [
          { id: 'feat-1', test_status: 'failed' },
          { id: 'feat-2', test_status: 'passed' },
        ],
      }));

      const discovery = createTargetDiscovery({
        polarisPath: projectDir,
      });

      const status = discovery.analyzeProjectStatus(projectDir);

      expect(status.name).toBe('test-project');
      expect(status.incompleteRequirements).toContain('req-1');
      expect(status.failedFeatures).toContain('feat-1');
    });

    it('should infer targets from status', () => {
      const discovery = createTargetDiscovery({
        polarisPath: projectDir,
      });

      const status = {
        name: 'test',
        incompleteRequirements: ['req-1'],
        failedFeatures: ['feat-1'],
        staleBranches: [],
        recentCommits: [],
      };

      const candidates = discovery.inferTargetsFromStatus(status);

      expect(candidates.length).toBe(2);
      expect(candidates[0]?.confidence).toBeGreaterThan(0);
    });

    it('should infer targets from arrow logs', () => {
      const discovery = createTargetDiscovery({
        polarisPath: projectDir,
      });

      const logs = [
        { project_id: 'test', target_id: 't1', ts: new Date().toISOString(), outcome: 'miss' as const, delta: 'Failed', next_action: 'shoot' as const },
        { project_id: 'test', target_id: 't1', ts: new Date().toISOString(), outcome: 'miss' as const, delta: 'Failed', next_action: 'shoot' as const },
        { project_id: 'test', target_id: 't1', ts: new Date().toISOString(), outcome: 'miss' as const, delta: 'Failed', next_action: 'shoot' as const },
      ];

      const candidates = discovery.inferTargetsFromArrowLogs(logs);

      expect(candidates.length).toBe(1);
      expect(candidates[0]?.title).toContain('t1');
    });
  });
});