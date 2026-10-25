import { z } from "zod";

export const SpecSchema = z.object({
  version: z.number().int().positive(),
  title: z.string().min(1),
  objective: z.string().min(1),
  paperResult: z.string().min(1),
  sourceRefs: z
    .array(
      z.object({ page: z.number().int().positive(), quote: z.string().min(1) }),
    )
    .min(1),
  data: z.object({
    description: z.string(),
    split: z.string(),
    preprocessing: z.string(),
  }),
  method: z.string().min(1),
  baseline: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
  metric: z.object({
    name: z.string(),
    computation: z.string(),
    publishedValue: z.number().nullable(),
    comparable: z.boolean(),
  }),
  requirements: z.object({
    cpuCores: z.number().positive(),
    ramGB: z.number().positive(),
    gpu: z.boolean(),
    vramGB: z.number().nonnegative(),
    diskGB: z.number().positive(),
  }),
  limits: z.object({
    timeSeconds: z.number().int().min(5).max(86400),
    maxHourlyUSD: z.number().nonnegative(),
    maxTotalUSD: z.number().nonnegative(),
  }),
  implementation: z.enum(["author", "independent"]),
  assumptions: z.array(z.string()),
  missing: z.array(z.string()),
  demo: z.enum(["bernoulli-hoeffding"]).nullable(),
});
export type ExperimentSpec = z.infer<typeof SpecSchema>;
export type RunStatus =
  | "draft"
  | "importing"
  | "planning"
  | "needs_setup"
  | "needs_data"
  | "ready"
  | "coding"
  | "selecting_compute"
  | "awaiting_approval"
  | "preparing"
  | "running"
  | "collecting"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";
export interface ExperimentInput {
  agentMode: "demo" | "pi";
  source: string;
  task: string;
  authorRepo?: string;
  dataDir?: string;
  mode: "local" | "vast" | "auto";
  timeSeconds: number;
  maxHourlyUSD: number;
  maxTotalUSD: number;
  cleanup: "destroy" | "retain";
}
export interface SourceDocument {
  original: string;
  textPath: string;
  pages: { page: number; text: string }[];
  sha256: string;
  title?: string;
}
export interface ComputeTarget {
  id: string;
  kind: "local" | "vast";
  label: string;
  cpuCores: number;
  ramGB: number;
  gpu: boolean;
  vramGB: number;
  diskGB: number;
  hourlyUSD: number;
  estimatedUSD: number;
  offerId?: number;
  details?: Record<string, unknown>;
}
export interface RunEvent {
  id: string;
  runId: string;
  at: string;
  type:
    | "status"
    | "log"
    | "agent"
    | "compaction"
    | "compute"
    | "artifact"
    | "error";
  message: string;
}
export interface Artifact {
  path: string;
  kind: "metrics" | "plot" | "config" | "log" | "predictions" | "other";
  bytes: number;
  sha256: string;
}
export interface PendingInput {
  id: string;
  text: string;
  delivery: "steer" | "followUp";
}
export interface ExperimentRun {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  status: RunStatus;
  input: ExperimentInput;
  dir: string;
  source?: SourceDocument;
  spec?: ExperimentSpec;
  planVersion: number;
  target?: ComputeTarget;
  pid?: number;
  instanceId?: number;
  attempts: number;
  artifacts: Artifact[];
  metrics?: Record<string, number>;
  verification?: string;
  report?: string;
  error?: string;
  artifactsCollected?: boolean;
  cleanupRequired?: boolean;
  executionStarted?: boolean;
  deadlineAt?: string;
  command?: string;
  sessionFile?: string;
  approvedPlanVersion?: number;
  pendingInputs?: PendingInput[];
  provisioningLabel?: string;
  provisioningUncertain?: boolean;
}
export interface AppSettings {
  piProvider: string;
  piModel: string;
  python: string;
  whisperBinary: string;
  whisperModel: string;
  sshKeyPath: string;
}
export interface ConnectionStatus {
  component: "pi" | "jev" | "vast" | "whisper" | "smartcompact";
  state: "ready" | "needs_setup" | "error";
  detail: string;
}
export interface Snapshot {
  runs: ExperimentRun[];
  activeId?: string;
  settings: AppSettings;
  connections: ConnectionStatus[];
}
export interface ProjectManifest {
  entryPoint: string;
  config: string;
  requirements: string;
  artifacts: string[];
}
export interface ComputeContext {
  run: ExperimentRun;
  spec: ExperimentSpec;
  projectDir: string;
  signal: AbortSignal;
  settings: AppSettings;
  emit: (type: RunEvent["type"], message: string) => Promise<void>;
  persist: (patch: Partial<ExperimentRun>) => Promise<void>;
}
export interface ComputeBackend {
  prepare(ctx: ComputeContext): Promise<void>;
  run(ctx: ComputeContext): Promise<{ exitCode: number; stderr: string }>;
  getStatus(ctx: ComputeContext): Promise<"running" | "stopped" | "unknown">;
  streamLogs(ctx: ComputeContext, listener: (line: string) => void): () => void;
  cancel(ctx: ComputeContext): Promise<void>;
  collectArtifacts(ctx: ComputeContext): Promise<void>;
  cleanup(ctx: ComputeContext): Promise<void>;
}
export type PiLoginMethod = "api_key" | "oauth";
export interface PiProvider {
  id: string;
  name: string;
  configured: boolean;
  methods: { type: PiLoginMethod; label: string }[];
  models: { id: string; name: string }[];
}
export interface PiLoginPrompt {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}
export type PiLoginNotice =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  | { type: "progress"; message: string }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    };
export interface PiLoginState {
  id: string;
  provider: string;
  status: "pending" | "completed" | "cancelled" | "failed";
  prompt?: PiLoginPrompt;
  notices: PiLoginNotice[];
  error?: string;
}
export interface ConversationBlock {
  id: string;
  at: number;
  kind: "user" | "assistant" | "tool";
  text: string;
  state: "streaming" | "running" | "done" | "error" | "cancelled";
  tool?: string;
  args?: string;
  durationMs?: number;
}
export interface ConversationPage {
  blocks: ConversationBlock[];
  before?: number;
  hasMore: boolean;
}
export interface ConversationUpdate {
  runId: string;
  blocks: ConversationBlock[];
  queued?: string[];
}
export interface ArtifactPreview {
  path: string;
  text: string;
  mime: string;
}
export interface CollabStatus {
  running: boolean; port?: number; expiresAt?: string;
  links: { origin: string; control: string; view: string }[];
  qr?: { control: string; view: string }[]; tunnel?: boolean; warning?: string;
}
export interface AppAPI {
  remote?: boolean;
  access?: 'control' | 'view';
  connection?(listener: (state: 'connected' | 'reconnecting' | 'expired') => void): () => void;
  disconnect?(): void;
  collab?: { status(): Promise<CollabStatus>; start(tunnel?: boolean): Promise<CollabStatus>; stop(): Promise<void>; };
  paperPdf?(id: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
  downloadArtifact?(id: string, artifactPath: string): Promise<void>;
  snapshot(): Promise<Snapshot>;
  create(input: ExperimentInput): Promise<ExperimentRun>;
  importPaper(source: string): Promise<ExperimentRun>;
  setBrief(id: string, input: ExperimentInput): Promise<void>;
  plan(id: string): Promise<void>;
  savePlan(id: string, spec: ExperimentSpec): Promise<void>;
  execute(id: string): Promise<void>;
  approve(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  cleanup(id: string): Promise<void>;
  sendMessage(
    id: string,
    text: string,
    delivery: "steer" | "followUp",
    pendingId?: string,
  ): Promise<void>;
  conversation(id: string, before?: number): Promise<ConversationPage>;
  artifactPreview(id: string, file: string): Promise<ArtifactPreview>;
  onConversation(listener: (update: ConversationUpdate) => void): () => void;
  openExternal(url: string): Promise<void>;
  saveSettings(settings: AppSettings): Promise<void>;
  piProviders(): Promise<PiProvider[]>;
  piLogin(provider: string, method: PiLoginMethod): Promise<PiLoginState>;
  piLoginState(id: string): Promise<PiLoginState>;
  piLoginRespond(id: string, promptId: string, value: string): Promise<void>;
  piLoginCancel(id: string): Promise<void>;
  openAuthLink(id: string, url: string): Promise<void>;
  choose(
    kind: "pdf" | "data" | "model" | "binary" | "key",
  ): Promise<string | null>;
  transcribe(audio: ArrayBuffer, requestId: string): Promise<string>;
  cancelTranscription(requestId: string): Promise<void>;
  requestMicrophoneAccess(): Promise<void>;
  events(id: string): Promise<RunEvent[]>;
  openFolder(id: string): Promise<void>;
  onEvent(listener: (event: RunEvent) => void): () => void;
}
declare global {
  interface Window {
    paper2: AppAPI;
  }
}
