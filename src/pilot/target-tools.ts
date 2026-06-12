/**
 * lobster_target_* tool definitions for Agent tool registration.
 *
 * These tools let the Pilot lobster (and human operators) create, query,
 * and manage target tree nodes within a project's sandbox.
 */

import type { TargetStore } from './targets';
import type { TargetStatus, ArrowLog } from './types';

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => unknown;
}

export function createTargetTools(store: TargetStore): ToolDef[] {
  return [
    {
      name: 'lobster_target_create',
      description: '创建靶子树节点。root_target 用于根本目标，test_target 用于测试驱动的子目标。叶子节点必须指定 leaf_test（可执行测试命令）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '唯一 ID，如 knowlever-root-001' },
          target_type: { type: 'string', enum: ['root_target', 'test_target'], description: '节点类型' },
          title: { type: 'string', description: '靶子标题（1-200字）' },
          description: { type: 'string', description: '详细描述' },
          parent_id: { type: 'string', description: '父节点 ID（根节点可省略）' },
          polaris_feature_ref: { type: 'string', description: '关联 polaris.json feature，如 R3.f1' },
          leaf_test: { type: 'string', description: '叶子节点的可执行测试命令' },
        },
        required: ['id', 'target_type', 'title', 'description'],
      },
      handler(args) {
        return store.create({
          id: String(args.id),
          type: String(args.target_type) as 'root_target' | 'test_target',
          title: String(args.title),
          description: String(args.description),
          parent_id: args.parent_id ? String(args.parent_id) : null,
          polaris_feature_ref: args.polaris_feature_ref ? String(args.polaris_feature_ref) : null,
          leaf_test: args.leaf_test ? String(args.leaf_test) : undefined,
        });
      },
    },

    {
      name: 'lobster_target_get',
      description: '获取指定靶子节点的完整信息。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '靶子 ID' },
        },
        required: ['id'],
      },
      handler(args) {
        const target = store.get(String(args.id));
        if (!target) throw new Error(`Target ${args.id} not found`);
        return target;
      },
    },

    {
      name: 'lobster_target_list',
      description: '列出靶子树节点。可按 status 或 type 过滤。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['active', 'completed', 'route_broken', 'paused_for_data', 'paused_for_human', 'dead'] },
          target_type: { type: 'string', enum: ['root_target', 'test_target'] },
        },
        required: [],
      },
      handler(args) {
        const filter: { status?: TargetStatus; type?: 'root_target' | 'test_target' } = {};
        if (args.status) filter.status = String(args.status) as TargetStatus;
        if (args.target_type) filter.type = String(args.target_type) as 'root_target' | 'test_target';
        const targets = store.list(filter);
        return {
          count: targets.length,
          targets: targets.map(t => ({
            id: t.id,
            type: t.type,
            title: t.title,
            status: t.status,
            parent_id: t.parent_id,
            children_count: t.children_ids.length,
            arrow_count: t.arrow_logs.length,
            polaris_feature_ref: t.polaris_feature_ref,
          })),
        };
      },
    },

    {
      name: 'lobster_target_update_status',
      description: '更新靶子节点状态。完成叶子节点时会自动向上传播 completed 状态。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '靶子 ID' },
          status: {
            type: 'string',
            enum: ['active', 'completed', 'route_broken', 'paused_for_data', 'paused_for_human', 'dead'],
            description: '新状态',
          },
        },
        required: ['id', 'status'],
      },
      handler(args) {
        const status = String(args.status) as TargetStatus;
        const target = store.updateStatus(String(args.id), status);
        if (status === 'completed') {
          store.propagateCompletion(target.id);
        }
        return { ok: true, target };
      },
    },

    {
      name: 'lobster_target_append_arrow_log',
      description: '记录一次射箭结果。miss 会累加 route_broken 和 unreachable 计数器；hit 重置 route_broken。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '靶子 ID' },
          outcome: { type: 'string', enum: ['miss', 'hit'], description: '落点结果' },
          delta: { type: 'string', description: '与靶心偏差描述' },
          next_action: { type: 'string', enum: ['shoot', 'moveboard', 'escalate'], description: '下一步动作' },
        },
        required: ['id', 'outcome', 'delta', 'next_action'],
      },
      handler(args) {
        const log: ArrowLog = {
          ts: new Date().toISOString(),
          outcome: String(args.outcome) as 'miss' | 'hit',
          delta: String(args.delta),
          next_action: String(args.next_action) as 'shoot' | 'moveboard' | 'escalate',
        };
        const target = store.appendArrowLog(String(args.id), log);

        const sc = target.stop_conditions;
        const flags: string[] = [];
        if (sc.route_broken.current >= sc.route_broken.n_failed_shots) {
          flags.push('route_broken');
        }
        if (sc.unreachable.current >= sc.unreachable.m_total_shots
            && sc.unreachable.moveboard_count >= 1) {
          flags.push('unreachable');
        }

        return {
          ok: true,
          target,
          triggered_flags: flags,
        };
      },
    },

    {
      name: 'lobster_target_move_board',
      description: '挪靶子 — 根据射箭落点更新测试目标。重置 route_broken 计数器，累加 moveboard_count。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '靶子 ID' },
          new_title: { type: 'string', description: '新标题' },
          new_description: { type: 'string', description: '新描述' },
        },
        required: ['id', 'new_title', 'new_description'],
      },
      handler(args) {
        const target = store.moveBoard(
          String(args.id),
          String(args.new_title),
          String(args.new_description),
        );
        return { ok: true, target };
      },
    },
  ];
}
