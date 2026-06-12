/**
 * Target JSON validation — lightweight schema checking without external deps.
 *
 * Uses the lobster-schema/target.schema.json structure as reference but
 * implements validation in code to avoid adding ajv dependency.
 */

import type { Target } from './types';

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const VALID_TYPES = ['root_target', 'test_target'] as const;
const VALID_STATUSES = ['active', 'completed', 'route_broken', 'paused_for_data', 'paused_for_human', 'pending_approval', 'dead'] as const;
const VALID_OUTCOMES = ['miss', 'hit'] as const;
const VALID_NEXT_ACTIONS = ['shoot', 'moveboard', 'escalate'] as const;

export function validateTarget(data: unknown): string[] {
  const errors: string[] = [];

  if (!data || typeof data !== 'object') {
    return ['Target must be a non-null object'];
  }

  const t = data as Record<string, unknown>;

  if (typeof t.id !== 'string' || !ID_PATTERN.test(t.id)) {
    errors.push(`id must match ${ID_PATTERN.source}, got: ${JSON.stringify(t.id)}`);
  }

  if (!VALID_TYPES.includes(t.type as typeof VALID_TYPES[number])) {
    errors.push(`type must be one of ${VALID_TYPES.join('|')}, got: ${JSON.stringify(t.type)}`);
  }

  if (typeof t.title !== 'string' || t.title.length === 0 || t.title.length > 200) {
    errors.push('title must be 1-200 characters');
  }

  if (typeof t.description !== 'string') {
    errors.push('description must be a string');
  }

  if (t.parent_id !== null && typeof t.parent_id !== 'string') {
    errors.push('parent_id must be string or null');
  }

  if (!Array.isArray(t.children_ids) || !t.children_ids.every((c: unknown) => typeof c === 'string')) {
    errors.push('children_ids must be string[]');
  }

  if (!VALID_STATUSES.includes(t.status as typeof VALID_STATUSES[number])) {
    errors.push(`status must be one of ${VALID_STATUSES.join('|')}`);
  }

  const sc = t.stop_conditions;
  if (!sc || typeof sc !== 'object') {
    errors.push('stop_conditions is required');
  } else {
    const s = sc as Record<string, unknown>;
    if (!validateRouteCondition(s.route_broken)) errors.push('stop_conditions.route_broken invalid');
    if (!validateDataMissing(s.data_missing)) errors.push('stop_conditions.data_missing invalid');
    if (!validateHumanIntervention(s.human_intervention)) errors.push('stop_conditions.human_intervention invalid');
    if (!validateUnreachable(s.unreachable)) errors.push('stop_conditions.unreachable invalid');
    if (!validateCompleted(s.completed)) errors.push('stop_conditions.completed invalid');
  }

  if (!Array.isArray(t.arrow_logs)) {
    errors.push('arrow_logs must be an array');
  } else {
    for (let i = 0; i < (t.arrow_logs as unknown[]).length; i++) {
      const log = (t.arrow_logs as unknown[])[i];
      const logErrors = validateArrowLog(log);
      if (logErrors.length > 0) {
        errors.push(`arrow_logs[${i}]: ${logErrors.join(', ')}`);
      }
    }
  }

  if (typeof t.created_at !== 'string') errors.push('created_at must be an ISO string');
  if (typeof t.updated_at !== 'string') errors.push('updated_at must be an ISO string');

  return errors;
}

function validateRouteCondition(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.n_failed_shots === 'number' && r.n_failed_shots >= 1
    && typeof r.current === 'number' && r.current >= 0;
}

function validateDataMissing(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return Array.isArray(d.depends_on) && d.depends_on.every((x: unknown) => typeof x === 'string');
}

function validateHumanIntervention(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const h = v as Record<string, unknown>;
  return Array.isArray(h.irreversible_actions) && Array.isArray(h.auth_needed);
}

function validateUnreachable(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const u = v as Record<string, unknown>;
  return typeof u.m_total_shots === 'number' && u.m_total_shots >= 1
    && typeof u.current === 'number' && u.current >= 0
    && typeof u.moveboard_count === 'number' && u.moveboard_count >= 0;
}

function validateCompleted(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return c.leaf_test === undefined || typeof c.leaf_test === 'string';
}

function validateArrowLog(v: unknown): string[] {
  const errors: string[] = [];
  if (!v || typeof v !== 'object') return ['must be an object'];
  const log = v as Record<string, unknown>;
  if (typeof log.ts !== 'string') errors.push('ts must be string');
  if (!VALID_OUTCOMES.includes(log.outcome as typeof VALID_OUTCOMES[number])) errors.push('outcome invalid');
  if (typeof log.delta !== 'string') errors.push('delta must be string');
  if (!VALID_NEXT_ACTIONS.includes(log.next_action as typeof VALID_NEXT_ACTIONS[number])) errors.push('next_action invalid');
  return errors;
}

export function isValidTargetId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function validateTargetPartial(data: Partial<Target>): string[] {
  const errors: string[] = [];
  if (data.id !== undefined && (typeof data.id !== 'string' || !ID_PATTERN.test(data.id))) {
    errors.push('id format invalid');
  }
  if (data.type !== undefined && !VALID_TYPES.includes(data.type)) {
    errors.push('type invalid');
  }
  if (data.status !== undefined && !VALID_STATUSES.includes(data.status)) {
    errors.push('status invalid');
  }
  return errors;
}
