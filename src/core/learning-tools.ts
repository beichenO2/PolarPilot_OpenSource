/**
 * Learning Tools — E3 思考模板自动注入闭环
 *
 * learning_run_arrow_pattern: 从 arrow_logs 分析高命中率 delta 模式，
 * 自动生成思考模板并注入到 patterns/ 目录。
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ArrowLogRecord } from '../pilot/arrow-log-exporter.js';
import type { Pattern } from '../templates/pattern-router.js';

export interface DeltaPattern {
  /** delta 关键词/短语 */
  keyword: string;
  /** 命中次数 */
  hitCount: number;
  /** 总次数 */
  totalCount: number;
  /** 命中率 */
  hitRate: number;
  /** 相关的 next_action 统计 */
  nextActions: Record<string, number>;
}

export interface PatternGenerationResult {
  /** 是否成功生成模板 */
  generated: boolean;
  /** 生成的模板名称（如有） */
  patternName?: string;
  /** 写入的文件路径（如有） */
  filePath?: string;
  /** 检测到的 delta 模式 */
  detectedPatterns: DeltaPattern[];
  /** 跳过原因（未生成时） */
  reason?: string;
}

/**
 * 从 arrow_logs 中提取 delta 关键词并统计命中率
 */
export function detectDeltaPatterns(logs: ArrowLogRecord[]): DeltaPattern[] {
  const patternMap = new Map<string, { hitCount: number; totalCount: number; nextActions: Record<string, number> }>();

  for (const log of logs) {
    const keywords = extractKeywords(log.delta);
    for (const kw of keywords) {
      const existing = patternMap.get(kw);
      if (existing) {
        existing.totalCount++;
        if (log.outcome === 'hit') existing.hitCount++;
        existing.nextActions[log.next_action] = (existing.nextActions[log.next_action] ?? 0) + 1;
      } else {
        const na: Record<string, number> = {};
        na[log.next_action] = 1;
        patternMap.set(kw, {
          hitCount: log.outcome === 'hit' ? 1 : 0,
          totalCount: 1,
          nextActions: na,
        });
      }
    }
  }

  const patterns: DeltaPattern[] = [];
  for (const [keyword, stats] of patternMap) {
    patterns.push({
      keyword,
      hitCount: stats.hitCount,
      totalCount: stats.totalCount,
      hitRate: stats.totalCount > 0 ? stats.hitCount / stats.totalCount : 0,
      nextActions: stats.nextActions,
    });
  }

  return patterns.sort((a, b) => b.hitRate - a.hitRate || b.totalCount - a.totalCount);
}

/**
 * 从 delta 文本中提取关键词
 * 简单策略：按空格/标点分词，过滤短词
 */
function extractKeywords(delta: string): string[] {
  // Split on common delimiters, keep tokens of length >= 2
  const tokens = delta.split(/[\s,;.!?，。；！？、\/\\()（）[\]{}:：""''""]+/);
  return tokens.filter(t => t.length >= 2);
}

/**
 * 根据 delta 模式生成思考模板
 */
export function generatePatternFromDeltas(patterns: DeltaPattern[], threshold = 0.6): Pattern | null {
  // 只取命中率 >= threshold 且出现次数 >= 2 的模式
  const highHitPatterns = patterns.filter(p => p.hitRate >= threshold && p.totalCount >= 2);
  if (highHitPatterns.length === 0) return null;

  // 取前 3 个高频关键词作为标签
  const topPatterns = highHitPatterns.slice(0, 3);
  const tags = topPatterns.map(p => p.keyword);
  const mainPattern = topPatterns[0]!;

  const patternName = `auto-${mainPattern.keyword.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '-')}`;

  return {
    name: patternName,
    tags,
    description: `Auto-generated pattern from arrow_logs analysis. High-hit-rate delta: "${mainPattern.keyword}" (${(mainPattern.hitRate * 100).toFixed(0)}% hit rate, ${mainPattern.totalCount} occurrences).`,
    steps: [
      `Identify the "${mainPattern.keyword}" pattern in the current context`,
      `Apply the proven approach that previously led to hits`,
      `Validate the change against the original target criteria`,
      `Log the outcome for continued learning`,
    ],
    applicable_types: ['test_target'],
    version: 'auto-1.0',
  };
}

/**
 * learning_run_arrow_pattern 工具主函数
 *
 * 完整闭环：分析 arrow_logs → 检测高命中率 delta 模式 → 生成思考模板 → 注入 patterns/ 目录
 */
export function learningRunArrowPattern(
  logs: ArrowLogRecord[],
  patternsDir: string,
  options?: { hitRateThreshold?: number; minOccurrences?: number },
): PatternGenerationResult {
  const threshold = options?.hitRateThreshold ?? 0.6;
  const minOccurrences = options?.minOccurrences ?? 2;

  if (logs.length === 0) {
    return { generated: false, detectedPatterns: [], reason: 'no arrow_logs to analyze' };
  }

  const detectedPatterns = detectDeltaPatterns(logs);
  const highHitPatterns = detectedPatterns.filter(p => p.hitRate >= threshold && p.totalCount >= minOccurrences);

  if (highHitPatterns.length === 0) {
    return { generated: false, detectedPatterns, reason: `no patterns with hit rate >= ${threshold} and occurrences >= ${minOccurrences}` };
  }

  const pattern = generatePatternFromDeltas(detectedPatterns, threshold);
  if (!pattern) {
    return { generated: false, detectedPatterns, reason: 'failed to generate pattern from deltas' };
  }

  // Check if pattern already exists
  const existingFiles = existsSync(patternsDir) ? readdirSync(patternsDir).filter(f => f.endsWith('.json')) : [];
  const targetFile = `${pattern.name}.json`;
  if (existingFiles.includes(targetFile)) {
    return { generated: false, detectedPatterns, patternName: pattern.name, reason: `pattern file ${targetFile} already exists` };
  }

  // Write pattern to patterns/ directory
  const filePath = join(patternsDir, targetFile);
  writeFileSync(filePath, JSON.stringify(pattern, null, 2), 'utf-8');

  return {
    generated: true,
    patternName: pattern.name,
    filePath,
    detectedPatterns,
  };
}
