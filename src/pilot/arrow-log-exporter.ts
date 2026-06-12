/**
 * Arrow Log Exporter — 导出 PolarPilot arrow_logs 到 PolarClaw LearningStore
 *
 * 将 target 文件中的 arrow_logs 转换为 ArrowLogRecord 格式，
 * 通过 HTTP API 发送到 PolarClaw 的自学习系统。
 */

import type { ArrowLog, Target } from './types.js';
import type { TargetStore } from './targets.js';

export interface ArrowLogRecord {
  project_id: string;
  target_id: string;
  ts: string;
  outcome: 'miss' | 'hit';
  delta: string;
  next_action: 'shoot' | 'moveboard' | 'escalate';
}

export interface ArrowLogExporterConfig {
  /** 项目 ID */
  projectId: string;
  /** PolarClaw API base URL */
  polarclawBaseUrl?: string;
  /** 自定义发送函数（用于测试或自定义传输） */
  sender?: (logs: ArrowLogRecord[]) => Promise<{ success: boolean; received: number }>;
}

export interface ArrowLogExporter {
  /** 导出所有 target 的 arrow_logs */
  exportAll(targetStore: TargetStore): ArrowLogRecord[];

  /** 导出单个 target 的 arrow_logs */
  exportTarget(target: Target): ArrowLogRecord[];

  /** 发送 arrow_logs 到 PolarClaw */
  send(logs: ArrowLogRecord[]): Promise<{ success: boolean; received: number; error?: string }>;

  /** 导出并发送（便捷方法） */
  exportAndSend(targetStore: TargetStore): Promise<{ success: boolean; sent: number; error?: string }>;
}

const DEFAULT_POLARCLAW_URL = 'http://127.0.0.1:4910';

export function createArrowLogExporter(config: ArrowLogExporterConfig): ArrowLogExporter {
  const { projectId, polarclawBaseUrl = DEFAULT_POLARCLAW_URL, sender } = config;

  function convertLog(targetId: string, log: ArrowLog): ArrowLogRecord {
    return {
      project_id: projectId,
      target_id: targetId,
      ts: log.ts,
      outcome: log.outcome,
      delta: log.delta,
      next_action: log.next_action,
    };
  }

  return {
    exportAll(targetStore) {
      const targets = targetStore.list();
      const records: ArrowLogRecord[] = [];

      for (const target of targets) {
        if (target.arrow_logs.length > 0) {
          records.push(...target.arrow_logs.map(log => convertLog(target.id, log)));
        }
      }

      return records.sort((a, b) => a.ts.localeCompare(b.ts));
    },

    exportTarget(target) {
      return target.arrow_logs.map(log => convertLog(target.id, log));
    },

    async send(logs) {
      if (logs.length === 0) {
        return { success: true, received: 0 };
      }

      if (sender) {
        const result = await sender(logs);
        return { success: result.success, received: result.received };
      }

      try {
        const response = await fetch(`${polarclawBaseUrl}/api/claw/learning/arrow-logs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(logs),
        });

        if (!response.ok) {
          const text = await response.text();
          return { success: false, received: 0, error: `HTTP ${response.status}: ${text}` };
        }

        const result = await response.json() as { success?: boolean; received?: number; errors?: string[] };
        return {
          success: result.success ?? true,
          received: result.received ?? logs.length,
          error: result.errors?.join('; '),
        };
      } catch (err) {
        return {
          success: false,
          received: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async exportAndSend(targetStore) {
      const logs = this.exportAll(targetStore);
      const result = await this.send(logs);
      return { ...result, sent: result.received };
    },
  };
}

/**
 * 从 targetStore 提取所有 arrow_logs 并转换为 ArrowLogRecord[]
 * 纯函数版本，不依赖 HTTP
 */
export function extractArrowLogs(
  targetStore: TargetStore,
  projectId: string,
): ArrowLogRecord[] {
  const targets = targetStore.list();
  const records: ArrowLogRecord[] = [];

  for (const target of targets) {
    for (const log of target.arrow_logs) {
      records.push({
        project_id: projectId,
        target_id: target.id,
        ts: log.ts,
        outcome: log.outcome,
        delta: log.delta,
        next_action: log.next_action,
      });
    }
  }

  return records.sort((a, b) => a.ts.localeCompare(b.ts));
}
