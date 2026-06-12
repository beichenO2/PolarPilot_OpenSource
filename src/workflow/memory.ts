import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Checkpoint, StepInput, StepOutput, Block, BlockSearchResult } from './types.js';

export interface MemoryManagerConfig {
  soulPath: string;
  workflowPath: string;
  scratchDir: string;
  polarMemoryUrl?: string;
}

export interface MemoryManager {
  readSoul(): string;
  fetchLongTermMemory(query: string, topK?: number): Promise<Block[]>;
  readCheckpoint(): Checkpoint;
  writeCheckpoint(cp: Checkpoint): void;
  refreshCheckpoint(): Checkpoint;
  writeStepInput(input: StepInput): void;
  readStepOutput(): StepOutput;
  clearScratch(): void;
  onStepStart(input: StepInput): void;
  onStepEnd(): void;
  onTaskComplete(): void;
  onTaskFailure(): void;
}

export function createMemoryManager(config: MemoryManagerConfig): MemoryManager {
  const checkpointPath = join(config.scratchDir, 'checkpoint.json');
  const stepInputPath = join(config.scratchDir, 'step_input.json');
  const stepOutputPath = join(config.scratchDir, 'step_output.json');
  const historyDir = join(config.scratchDir, 'history');

  function ensureScratchDir(): void {
    if (!existsSync(config.scratchDir)) {
      mkdirSync(config.scratchDir, { recursive: true });
    }
  }

  return {
    readSoul(): string {
      return readFileSync(config.soulPath, 'utf-8');
    },

    async fetchLongTermMemory(query: string, topK = 10): Promise<Block[]> {
      if (!config.polarMemoryUrl) return [];
      try {
        const resp = await fetch(`${config.polarMemoryUrl}/api/blocks/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, top_k: topK }),
        });
        if (!resp.ok) return [];
        const data = (await resp.json()) as BlockSearchResult;
        return data.blocks ?? [];
      } catch {
        return [];
      }
    },

    readCheckpoint(): Checkpoint {
      ensureScratchDir();
      if (!existsSync(checkpointPath)) {
        return {
          workflow_id: '',
          current_step: '',
          completed_steps: [],
          global_learnings: [],
          artifacts: {},
          updated_at: new Date().toISOString(),
        };
      }
      return JSON.parse(readFileSync(checkpointPath, 'utf-8')) as Checkpoint;
    },

    writeCheckpoint(cp: Checkpoint): void {
      ensureScratchDir();
      cp.updated_at = new Date().toISOString();
      writeFileSync(checkpointPath, JSON.stringify(cp, null, 2));
    },

    refreshCheckpoint(): Checkpoint {
      ensureScratchDir();
      if (!existsSync(checkpointPath)) {
        return {
          workflow_id: '',
          current_step: '',
          completed_steps: [],
          global_learnings: [],
          artifacts: {},
          updated_at: new Date().toISOString(),
        };
      }
      try {
        const raw = readFileSync(checkpointPath, 'utf-8');
        const parsed = JSON.parse(raw) as Checkpoint;
        // Validate integrity — all required fields must be present
        if (
          typeof parsed.workflow_id !== 'string' ||
          typeof parsed.current_step !== 'string' ||
          !Array.isArray(parsed.completed_steps) ||
          !Array.isArray(parsed.global_learnings) ||
          typeof parsed.artifacts !== 'object' ||
          typeof parsed.updated_at !== 'string'
        ) {
          // Corrupted — recover with safe defaults preserving what we can
          const recovered: Checkpoint = {
            workflow_id: typeof parsed.workflow_id === 'string' ? parsed.workflow_id : '',
            current_step: typeof parsed.current_step === 'string' ? parsed.current_step : '',
            completed_steps: Array.isArray(parsed.completed_steps) ? parsed.completed_steps : [],
            global_learnings: Array.isArray(parsed.global_learnings) ? parsed.global_learnings : [],
            artifacts: (parsed.artifacts && typeof parsed.artifacts === 'object' && !Array.isArray(parsed.artifacts))
              ? parsed.artifacts as Record<string, string>
              : {},
            updated_at: new Date().toISOString(),
          };
          writeFileSync(checkpointPath, JSON.stringify(recovered, null, 2));
          return recovered;
        }
        return parsed;
      } catch {
        // File is unreadable / unparseable — return fresh checkpoint
        const fresh: Checkpoint = {
          workflow_id: '',
          current_step: '',
          completed_steps: [],
          global_learnings: [],
          artifacts: {},
          updated_at: new Date().toISOString(),
        };
        writeFileSync(checkpointPath, JSON.stringify(fresh, null, 2));
        return fresh;
      }
    },

    writeStepInput(input: StepInput): void {
      ensureScratchDir();
      writeFileSync(stepInputPath, JSON.stringify(input, null, 2));
    },

    readStepOutput(): StepOutput {
      ensureScratchDir();
      if (!existsSync(stepOutputPath)) {
        return {
          step_id: '',
          result: 'failure',
          summary: 'No step output found',
          artifacts: [],
          learnings: [],
        };
      }
      return JSON.parse(readFileSync(stepOutputPath, 'utf-8')) as StepOutput;
    },

    clearScratch(): void {
      if (existsSync(stepInputPath)) rmSync(stepInputPath);
      if (existsSync(stepOutputPath)) rmSync(stepOutputPath);
    },

    onStepStart(input: StepInput): void {
      this.clearScratch();
      this.writeStepInput(input);
    },

    onStepEnd(): void {
      const output = this.readStepOutput();
      const checkpoint = this.readCheckpoint();
      checkpoint.completed_steps.push(checkpoint.current_step);
      checkpoint.current_step = output.next_hint ?? '';
      checkpoint.global_learnings.push(...output.learnings);
      for (const artifact of output.artifacts) {
        checkpoint.artifacts[output.step_id] = artifact;
      }
      this.writeCheckpoint(checkpoint);

      // Archive step output to history
      if (!existsSync(historyDir)) {
        mkdirSync(historyDir, { recursive: true });
      }
      const stepArchivePath = join(historyDir, `step-${output.step_id}-${Date.now()}.json`);
      writeFileSync(stepArchivePath, JSON.stringify(output, null, 2));

      this.clearScratch();
    },

    onTaskComplete(): void {
      const checkpoint = this.readCheckpoint();

      // Write final summary checkpoint before archiving
      const summaryCheckpoint: Checkpoint = {
        ...checkpoint,
        current_step: '__COMPLETE__',
        updated_at: new Date().toISOString(),
      };
      this.writeCheckpoint(summaryCheckpoint);

      if (!existsSync(historyDir)) {
        mkdirSync(historyDir, { recursive: true });
      }
      const archivePath = join(historyDir, `checkpoint-${Date.now()}.json`);
      writeFileSync(archivePath, JSON.stringify(summaryCheckpoint, null, 2));
      // Clear all temporary files
      this.clearScratch();
      if (existsSync(checkpointPath)) rmSync(checkpointPath);
    },

    onTaskFailure(): void {
      // Preserve checkpoint for recovery, only clear scratch (Layer 4)
      this.clearScratch();
    },
  };
}