/**
 * Target tree store — file-based CRUD for lobster/targets/*.json + *.md.
 *
 * Each target is a JSON file named <id>.json with a companion <id>.md
 * for human readability. The JSON is the canonical source; the .md is
 * regenerated on every write.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Target, TargetStatus, ArrowLog, StopConditions } from './types';
import { validateTarget } from './target-validator';

export interface TargetStoreConfig {
  targetsDir: string;
}

export function createTargetStore(config: TargetStoreConfig) {
  const { targetsDir } = config;
  if (!existsSync(targetsDir)) mkdirSync(targetsDir, { recursive: true });

  const gitkeep = join(targetsDir, '.gitkeep');
  if (!existsSync(gitkeep)) writeFileSync(gitkeep, '');

  function jsonPath(id: string): string { return join(targetsDir, `${id}.json`); }
  function mdPath(id: string): string { return join(targetsDir, `${id}.md`); }

  function readTarget(id: string): Target | undefined {
    const p = jsonPath(id);
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as Target;
    } catch { return undefined; }
  }

  function writeTarget(target: Target): void {
    const errors = validateTarget(target);
    if (errors.length > 0) {
      throw new Error(`Target validation failed: ${errors.join('; ')}`);
    }
    writeFileSync(jsonPath(target.id), JSON.stringify(target, null, 2));
    writeFileSync(mdPath(target.id), renderMarkdown(target));
  }

  function renderMarkdown(t: Target): string {
    const lines: string[] = [
      `# ${t.title}`,
      '',
      `> ID: \`${t.id}\` | Type: ${t.type} | Status: **${t.status}**`,
      `> Created: ${t.created_at} | Updated: ${t.updated_at}`,
      '',
    ];

    if (t.polaris_feature_ref) {
      lines.push(`**Polaris Feature Ref:** \`${t.polaris_feature_ref}\``);
      lines.push('');
    }

    if (t.parent_id) {
      lines.push(`**Parent:** \`${t.parent_id}\``);
      lines.push('');
    }

    lines.push('## Description', '', t.description, '');

    if (t.children_ids.length > 0) {
      lines.push('## Children');
      for (const cid of t.children_ids) lines.push(`- \`${cid}\``);
      lines.push('');
    }

    lines.push('## Stop Conditions', '');
    const sc = t.stop_conditions;
    lines.push(`- **route_broken**: ${sc.route_broken.current}/${sc.route_broken.n_failed_shots} consecutive failures`);
    if (sc.data_missing.depends_on.length > 0) {
      lines.push(`- **data_missing**: depends on ${sc.data_missing.depends_on.join(', ')}`);
    }
    if (sc.human_intervention.irreversible_actions.length > 0 || sc.human_intervention.auth_needed.length > 0) {
      lines.push(`- **human_intervention**: irreversible=[${sc.human_intervention.irreversible_actions.join(',')}], auth=[${sc.human_intervention.auth_needed.join(',')}]`);
    }
    lines.push(`- **unreachable**: ${sc.unreachable.current}/${sc.unreachable.m_total_shots} total shots, ${sc.unreachable.moveboard_count} moveboards`);
    if (sc.completed.leaf_test) {
      lines.push(`- **completed**: \`${sc.completed.leaf_test}\``);
    }
    lines.push('');

    if (t.arrow_logs.length > 0) {
      lines.push('## Arrow Log', '');
      lines.push('| Time | Outcome | Delta | Next |');
      lines.push('|------|---------|-------|------|');
      for (const log of t.arrow_logs) {
        lines.push(`| ${log.ts} | ${log.outcome} | ${log.delta.slice(0, 60)} | ${log.next_action} |`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  function makeDefaultStopConditions(routeN: number, unreachableM: number): StopConditions {
    return {
      route_broken: { n_failed_shots: routeN, current: 0 },
      data_missing: { depends_on: [] },
      human_intervention: { irreversible_actions: [], auth_needed: [] },
      unreachable: { m_total_shots: unreachableM, current: 0, moveboard_count: 0 },
      completed: {},
    };
  }

  return {
    create(params: {
      id: string;
      type: Target['type'];
      title: string;
      description: string;
      parent_id?: string | null;
      polaris_feature_ref?: string | null;
      leaf_test?: string;
      stop_conditions?: Partial<StopConditions>;
      status?: TargetStatus;
    }): Target {
      if (readTarget(params.id)) {
        throw new Error(`Target ${params.id} already exists`);
      }

      if (params.parent_id) {
        const parent = readTarget(params.parent_id);
        if (!parent) throw new Error(`Parent target ${params.parent_id} not found`);
        if (!parent.children_ids.includes(params.id)) {
          parent.children_ids.push(params.id);
          parent.updated_at = new Date().toISOString();
          writeTarget(parent);
        }
      }

      const now = new Date().toISOString();
      const defaults = makeDefaultStopConditions(3, 5);
      const sc: StopConditions = {
        ...defaults,
        ...params.stop_conditions,
        completed: {
          ...defaults.completed,
          ...params.stop_conditions?.completed,
          leaf_test: params.leaf_test ?? params.stop_conditions?.completed?.leaf_test,
        },
      };

      const target: Target = {
        id: params.id,
        type: params.type,
        title: params.title,
        description: params.description,
        parent_id: params.parent_id ?? null,
        children_ids: [],
        status: params.status ?? 'active',
        stop_conditions: sc,
        polaris_feature_ref: params.polaris_feature_ref ?? null,
        arrow_logs: [],
        created_at: now,
        updated_at: now,
      };

      writeTarget(target);
      return target;
    },

    get(id: string): Target | undefined {
      return readTarget(id);
    },

    list(filter?: { status?: TargetStatus; type?: Target['type'] }): Target[] {
      const files = readdirSync(targetsDir).filter(f => f.endsWith('.json'));
      const targets: Target[] = [];
      for (const f of files) {
        try {
          const t = JSON.parse(readFileSync(join(targetsDir, f), 'utf8')) as Target;
          if (filter?.status && t.status !== filter.status) continue;
          if (filter?.type && t.type !== filter.type) continue;
          targets.push(t);
        } catch { /* skip corrupt files */ }
      }
      return targets.sort((a, b) => a.created_at.localeCompare(b.created_at));
    },

    updateStatus(id: string, status: TargetStatus): Target {
      const target = readTarget(id);
      if (!target) throw new Error(`Target ${id} not found`);
      target.status = status;
      target.updated_at = new Date().toISOString();
      writeTarget(target);
      return target;
    },

    appendArrowLog(id: string, log: ArrowLog): Target {
      const target = readTarget(id);
      if (!target) throw new Error(`Target ${id} not found`);

      target.arrow_logs.push(log);

      if (log.outcome === 'miss') {
        target.stop_conditions.route_broken.current++;
        target.stop_conditions.unreachable.current++;
      } else {
        target.stop_conditions.route_broken.current = 0;
      }

      target.updated_at = new Date().toISOString();
      writeTarget(target);
      return target;
    },

    moveBoard(id: string, newTitle: string, newDescription: string): Target {
      const target = readTarget(id);
      if (!target) throw new Error(`Target ${id} not found`);

      target.title = newTitle;
      target.description = newDescription;
      target.stop_conditions.unreachable.moveboard_count++;
      target.stop_conditions.route_broken.current = 0;
      target.updated_at = new Date().toISOString();

      writeTarget(target);
      return target;
    },

    delete(id: string): boolean {
      const target = readTarget(id);
      if (!target) return false;

      if (target.parent_id) {
        const parent = readTarget(target.parent_id);
        if (parent) {
          parent.children_ids = parent.children_ids.filter(c => c !== id);
          parent.updated_at = new Date().toISOString();
          writeTarget(parent);
        }
      }

      try { unlinkSync(jsonPath(id)); } catch { /* ok */ }
      try { unlinkSync(mdPath(id)); } catch { /* ok */ }
      return true;
    },

    checkCompletion(id: string): boolean {
      const target = readTarget(id);
      if (!target) return false;

      if (target.children_ids.length === 0) return target.status === 'completed';

      return target.children_ids.every(cid => {
        const child = readTarget(cid);
        return child?.status === 'completed';
      });
    },

    propagateCompletion(id: string): void {
      const target = readTarget(id);
      if (!target || !target.parent_id) return;

      const parent = readTarget(target.parent_id);
      if (!parent) return;

      const allChildrenDone = parent.children_ids.every(cid => {
        const child = readTarget(cid);
        return child?.status === 'completed';
      });

      if (allChildrenDone && parent.status === 'active') {
        parent.status = 'completed';
        parent.updated_at = new Date().toISOString();
        writeTarget(parent);
        this.propagateCompletion(parent.id);
      }
    },
  };
}

export type TargetStore = ReturnType<typeof createTargetStore>;
