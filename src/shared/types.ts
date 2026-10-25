import { z } from 'zod';

export const SpecSchema = z.object({
  version: z.number().int().positive(),
  title: z.string().min(1), objective: z.string().min(1), paperResult: z.string().min(1),
  sourceRefs: z.array(z.object({ page: z.number().int().positive(), quote: z.string().min(1) })).min(1),
  data: z.object({ description: z.string(), split: z.string(), preprocessing: z.string() }),
  method: z.string().min(1), baseline: z.string().min(1), parameters: z.record(z.string(), z.unknown()),
  metric: z.object({ name: z.string(), computation: z.string(), publishedValue: z.number().nullable(), comparable: z.boolean() }),
  requirements: z.object({ cpuCores: z.number().positive(), ramGB: z.number().positive(), gpu: z.boolean(), vramGB: z.number().nonnegative(), diskGB: z.number().positive() }),
  limits: z.object({ timeSeconds: z.number().int().min(5).max(86400), maxHourlyUSD: z.number().nonnegative(), maxTotalUSD: z.number().nonnegative() }),
  implementation: z.enum(['author', 'independent']), assumptions: z.array(z.string()), missing: z.array(z.string()),
  demo: z.enum(['bernoulli-hoeffding']).nullable()
});
export type ExperimentSpec = z.infer<typeof SpecSchema>;
export type RunStatus = 'draft' | 'importing' | 'planning' | 'needs_setup' | 'needs_data' | 'ready' | 'coding' | 'selecting_compute' | 'awaiting_approval' | 'preparing' | 'running' | 'collecting' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
export interface ExperimentInput { agentMode: 'demo' | 'pi'; source: string; task: string; authorRepo?: string; dataDir?: string; mode: 'local' | 'vast' | 'auto'; timeSeconds: number; maxHourlyUSD: number; maxTotalUSD: number; cleanup: 'destroy' | 'retain'; }
export interface SourceDocument { original: string; textPath: string; pages: { page: number; text: string }[]; sha256: string; }
export interface ComputeTarget { id: string; kind: 'local' | 'vast'; label: string; cpuCores: number; ramGB: number; gpu: boolean; vramGB: number; diskGB: number; hourlyUSD: number; estimatedUSD: number; offerId?: number; details?: Record<string, unknown>; }
export interface RunEvent { id: string; runId: string; at: string; type: 'status' | 'log' | 'agent' | 'compaction' | 'compute' | 'artifact' | 'error'; message: string; }
export interface Artifact { path: string; kind: 'metrics' | 'plot' | 'config' | 'log' | 'predictions' | 'other'; bytes: number; sha256: string; }
export interface ExperimentRun {
  id: string; createdAt: string; updatedAt: string; title: string; status: RunStatus; input: ExperimentInput;
  dir: string; source?: SourceDocument; spec?: ExperimentSpec; planVersion: number; target?: ComputeTarget;
  pid?: number; instanceId?: number; attempts: number;
  artifacts: Artifact[]; metrics?: Record<string, number>; verification?: string; report?: string; error?: string;
  artifactsCollected?: boolean; cleanupRequired?: boolean; executionStarted?: boolean; deadlineAt?: string; command?: string;
  provisioningLabel?: string; provisioningUncertain?: boolean;
}
export interface AppSettings { piProvider: string; piModel: string; python: string; whisperBinary: string; whisperModel: string; sshKeyPath: string; }
export interface ConnectionStatus { component: 'pi' | 'jev' | 'vast' | 'whisper' | 'smartcompact'; state: 'ready' | 'needs_setup' | 'error'; detail: string; }
export interface Snapshot { runs: ExperimentRun[]; activeId?: string; settings: AppSettings; connections: ConnectionStatus[]; }
export interface ProjectManifest { entryPoint: string; config: string; requirements: string; artifacts: string[]; }
export interface ComputeContext {
  run: ExperimentRun; spec: ExperimentSpec; projectDir: string; signal: AbortSignal; settings: AppSettings;
  emit: (type: RunEvent['type'], message: string) => Promise<void>;
  persist: (patch: Partial<ExperimentRun>) => Promise<void>;
}
export interface ComputeBackend {
  prepare(ctx: ComputeContext): Promise<void>;
  run(ctx: ComputeContext): Promise<{ exitCode: number; stderr: string }>;
  getStatus(ctx: ComputeContext): Promise<'running' | 'stopped' | 'unknown'>;
  streamLogs(ctx: ComputeContext, listener: (line: string) => void): () => void;
  cancel(ctx: ComputeContext): Promise<void>;
  collectArtifacts(ctx: ComputeContext): Promise<void>;
  cleanup(ctx: ComputeContext): Promise<void>;
}
export interface AppAPI {
  snapshot(): Promise<Snapshot>;
  create(input: ExperimentInput): Promise<ExperimentRun>;
  plan(id: string): Promise<void>;
  savePlan(id: string, spec: ExperimentSpec): Promise<void>;
  execute(id: string): Promise<void>;
  approve(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  cleanup(id: string): Promise<void>;
  saveSettings(settings: AppSettings): Promise<void>;
  choose(kind: 'pdf' | 'data' | 'model' | 'binary' | 'key'): Promise<string | null>;
  requestMicrophoneAccess(): Promise<void>;
  transcribe(audio: ArrayBuffer, requestId: string): Promise<string>;
  cancelTranscription(requestId: string): Promise<void>;
  events(id: string): Promise<RunEvent[]>;
  openFolder(id: string): Promise<void>;
  onEvent(listener: (event: RunEvent) => void): () => void;
}
declare global { interface Window { paper2: AppAPI; } }
