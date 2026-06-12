/**
 * Target Discovery — 自主目标发现模块
 *
 * 系统根据项目状态、生态事件、KnowLever 知识注入，自主生成候选 target。
 * 发现的 target 状态为 pending_approval，必须经过人类确认后才能执行。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TargetType } from './types.js';
import type { ArrowLogRecord } from './arrow-log-exporter.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface DiscoverySource {
  type: 'project_status' | 'ecosystem_event' | 'knowledge_update' | 'arrow_pattern';
  data: unknown;
}

export interface CandidateTarget {
  title: string;
  description: string;
  type: TargetType;
  confidence: number;  // 0-1，发现置信度
  sources: DiscoverySource[];
  suggested_actions?: string[];
}

export interface ProjectStatus {
  name: string;
  incompleteRequirements: string[];
  failedFeatures: string[];
  staleBranches: string[];
  recentCommits: { hash: string; message: string; ts: string }[];
}

export interface TargetDiscovery {
  discover(projectId: string): Promise<CandidateTarget[]>;
  analyzeProjectStatus(polarisPath: string): ProjectStatus;
  inferTargetsFromStatus(status: ProjectStatus): CandidateTarget[];
  inferTargetsFromArrowLogs(logs: ArrowLogRecord[]): CandidateTarget[];
}

export interface TargetDiscoveryConfig {
  polarisPath: string;
  arrowLogExporter?: { exportAll: (store: unknown) => ArrowLogRecord[] };
  knowleverClient?: { getRelevantUpdates: (projectId: string) => Promise<unknown[]> };
}

// ── Implementation ─────────────────────────────────────────────────────

export function createTargetDiscovery(config: TargetDiscoveryConfig): TargetDiscovery {
  const { polarisPath, arrowLogExporter, knowleverClient } = config;

  return {
    async discover(projectId: string): Promise<CandidateTarget[]> {
      const candidates: CandidateTarget[] = [];

      // 1. 分析项目状态
      const status = this.analyzeProjectStatus(polarisPath);
      candidates.push(...this.inferTargetsFromStatus(status));

      // 2. 分析 arrow_logs 模式（如果可用）
      if (arrowLogExporter) {
        const logs = arrowLogExporter.exportAll(null as any);
        candidates.push(...this.inferTargetsFromArrowLogs(logs));
      }

      // 3. 查询 KnowLever 知识更新（如果可用）
      if (knowleverClient) {
        try {
          const knowledge = await knowleverClient.getRelevantUpdates(projectId);
          candidates.push(...inferTargetsFromKnowledge(knowledge));
        } catch (err) {
          console.error('[TargetDiscovery] KnowLever query failed:', err);
        }
      }

      // 按置信度排序
      return candidates.sort((a, b) => b.confidence - a.confidence);
    },

    analyzeProjectStatus(polarisPath: string): ProjectStatus {
      const status: ProjectStatus = {
        name: '',
        incompleteRequirements: [],
        failedFeatures: [],
        staleBranches: [],
        recentCommits: [],
      };

      const polarisFile = join(polarisPath, 'polaris.json');
      if (!existsSync(polarisFile)) {
        return status;
      }

      try {
        const content = readFileSync(polarisFile, 'utf-8');
        const polaris = JSON.parse(content) as {
          name?: string;
          requirements?: { id: string; status: string }[];
          features?: { id: string; test_status?: string }[];
        };

        status.name = polaris.name || '';

        // 提取未完成的需求
        if (polaris.requirements) {
          status.incompleteRequirements = polaris.requirements
            .filter(r => r.status !== 'completed')
            .map(r => r.id);
        }

        // 提取测试失败的 features
        if (polaris.features) {
          status.failedFeatures = polaris.features
            .filter(f => f.test_status === 'failed')
            .map(f => f.id);
        }
      } catch (err) {
        console.error('[TargetDiscovery] Failed to parse polaris.json:', err);
      }

      return status;
    },

    inferTargetsFromStatus(status: ProjectStatus): CandidateTarget[] {
      const candidates: CandidateTarget[] = [];

      // 从未完成需求推断
      for (const reqId of status.incompleteRequirements) {
        candidates.push({
          title: `Complete requirement: ${reqId}`,
          description: `Requirement "${reqId}" is marked as incomplete. Consider creating a target to complete it.`,
          type: 'root_target',
          confidence: 0.7,
          sources: [{ type: 'project_status', data: { requirement: reqId } }],
          suggested_actions: ['Review requirement details', 'Create test targets'],
        });
      }

      // 从失败测试推断
      for (const featureId of status.failedFeatures) {
        candidates.push({
          title: `Fix failing tests for: ${featureId}`,
          description: `Feature "${featureId}" has failing tests. Consider creating a target to fix them.`,
          type: 'root_target',
          confidence: 0.8,
          sources: [{ type: 'project_status', data: { feature: featureId, test_status: 'failed' } }],
          suggested_actions: ['Run tests to see failures', 'Identify root cause', 'Fix and verify'],
        });
      }

      return candidates;
    },

    inferTargetsFromArrowLogs(logs: ArrowLogRecord[]): CandidateTarget[] {
      const candidates: CandidateTarget[] = [];

      if (logs.length === 0) return candidates;

      // 分析重复 miss 模式
      const missCountByTarget = new Map<string, { count: number; lastDelta: string }>();

      for (const log of logs) {
        if (log.outcome === 'miss') {
          const existing = missCountByTarget.get(log.target_id);
          if (existing) {
            existing.count++;
            existing.lastDelta = log.delta;
          } else {
            missCountByTarget.set(log.target_id, { count: 1, lastDelta: log.delta });
          }
        }
      }

      // 对于连续 miss 超过 3 次的 target，建议改进
      for (const [targetId, data] of missCountByTarget) {
        if (data.count >= 3) {
          candidates.push({
            title: `Investigate repeated misses on target: ${targetId}`,
            description: `Target "${targetId}" has ${data.count} consecutive misses. Last delta: "${data.lastDelta.slice(0, 100)}...". Consider reviewing the approach.`,
            type: 'test_target',
            confidence: 0.6,
            sources: [{ type: 'arrow_pattern', data: { target_id: targetId, miss_count: data.count } }],
            suggested_actions: ['Review arrow_logs history', 'Consider alternative approach', 'Check for blockers'],
          });
        }
      }

      return candidates;
    },
  };
}

// ── Helper Functions ───────────────────────────────────────────────────

function inferTargetsFromKnowledge(knowledge: unknown[]): CandidateTarget[] {
  const candidates: CandidateTarget[] = [];

  if (!Array.isArray(knowledge)) return candidates;

  for (const item of knowledge) {
    const k = item as { title?: string; description?: string; relevance?: number };
    if (k.title && k.relevance && k.relevance > 0.5) {
      candidates.push({
        title: `Apply knowledge: ${k.title}`,
        description: k.description || `New knowledge relevant to the project: ${k.title}`,
        type: 'root_target',
        confidence: k.relevance * 0.5,
        sources: [{ type: 'knowledge_update', data: k }],
      });
    }
  }

  return candidates;
}
