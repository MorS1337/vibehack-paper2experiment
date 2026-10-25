import { SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { ArtifactPreview, ConversationBlock, ConversationPage, ExperimentRun } from '../shared/types.js';

type SessionMessage = AgentSession['messages'][number];
const DISPLAY_LIMIT = 64 * 1024;

export function displayText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
  let safe = text.replace(/\b(?:oc_sk_[\w-]+|sk-ant-[\w-]+|sk-proj-[\w-]+)\b/g, '[redacted]');
  for (const [name, secret] of Object.entries(process.env)) {
    if (secret && secret.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)) safe = safe.split(secret).join('[redacted]');
  }
  return safe.length <= DISPLAY_LIMIT ? safe : `${safe.slice(0, DISPLAY_LIMIT)}\n[Preview truncated; full output remains in the Pi session.]`;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return displayText(content);
  if (!Array.isArray(content)) return '';
  return displayText(content.filter(part => part?.type === 'text').map(part => part.text).join('\n'));
}

/** Projection only: Pi's on-disk messages, not operational log strings, own the conversation. */
export function messageBlocks(message: SessionMessage, streaming = false): ConversationBlock[] {
  if (message.role === 'user') return [{ id: `user:${message.timestamp}`, at: message.timestamp, kind: 'user', text: contentText(message.content), state: 'done' }];
  if (message.role === 'assistant') {
    const blocks: ConversationBlock[] = [];
    message.content.forEach((part, index) => {
      if (part.type === 'text') blocks.push({ id: `assistant:${message.timestamp}:${index}`, at: message.timestamp, kind: 'assistant', text: displayText(part.text), state: streaming ? 'streaming' : message.stopReason === 'error' ? 'error' : message.stopReason === 'aborted' ? 'cancelled' : 'done' });
      if (part.type === 'toolCall') blocks.push({ id: part.id, at: message.timestamp, kind: 'tool', tool: part.name, args: displayText(part.arguments), text: '', state: 'running' });
    });
    if (message.errorMessage) blocks.push({ id: `error:${message.timestamp}`, at: message.timestamp, kind: 'assistant', text: displayText(message.errorMessage), state: 'error' });
    return blocks;
  }
  if (message.role === 'toolResult') {
    const details = message.details as { diff?: unknown } | undefined;
    const diff = typeof details?.diff === 'string' ? `\n\n${details.diff}` : '';
    return [{ id: message.toolCallId, at: message.timestamp, kind: 'tool', tool: message.toolName, text: contentText(message.content) + displayText(diff), state: message.isError ? 'error' : 'done' }];
  }
  return [];
}

export function projectMessages(messages: SessionMessage[], active: boolean): ConversationBlock[] {
  const blocks = new Map<string, ConversationBlock>();
  for (const message of messages) for (const block of messageBlocks(message)) {
    const prior = blocks.get(block.id);
    blocks.set(block.id, { ...prior, ...block, at: prior?.at ?? block.at });
  }
  return [...blocks.values()].map(block => !active && block.state === 'running' ? { ...block, state: 'cancelled' } : block);
}

export function readConversation(run: ExperimentRun, before?: number, active = false): ConversationPage {
  if (!run.sessionFile) return { blocks: [], hasMore: false };
  const manager = SessionManager.open(run.sessionFile);
  const branch = manager.getBranch();
  const messages = branch.flatMap(entry => entry.type === 'message' ? [entry.message] : []);
  const durations = new Map<string, number>();
  for (const entry of branch) if (entry.type === 'custom' && entry.customType === 'harness.tool') {
    const data = entry.data as { id?: string; durationMs?: number };
    if (data.id && typeof data.durationMs === 'number') durations.set(data.id, data.durationMs);
  }
  const all = projectMessages(messages, active).map(block => durations.has(block.id) ? { ...block, durationMs: durations.get(block.id) } : block);
  const end = before === undefined ? all.length : Math.min(before, all.length);
  const start = Math.max(0, end - 100);
  return { blocks: all.slice(start, end), before: start, hasMore: start > 0 };
}

export async function readArtifactPreview(run: ExperimentRun, relative: string): Promise<ArtifactPreview> {
  if (!relative || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid artifact path');
  // Only the run's generated workspace and collected export are exposed, never auth/session storage.
  if (!relative.startsWith('project/') && !run.artifacts.some(artifact => artifact.path === relative)) throw new Error('File is outside the experiment workspace');
  const base = await realpath(run.dir);
  let file = base;
  for (const segment of relative.split('/')) {
    file = path.join(file, segment);
    if ((await lstat(file)).isSymbolicLink()) throw new Error('Symlink previews are not allowed');
  }
  const resolved = await realpath(file);
  if (!resolved.startsWith(base + path.sep)) throw new Error('Artifact escapes the experiment directory');
  const extension = path.extname(file).toLowerCase();
  if (!['.svg', '.json', '.py', '.txt', '.md', '.log', '.csv'].includes(extension)) throw new Error('Unsupported preview format');
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 512 * 1024) throw new Error('Preview requires a regular file of at most 512 KiB');
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > info.size) throw new Error('File changed during preview; retry');
    return { path: relative, text: buffer.toString('utf8', 0, bytesRead), mime: extension === '.svg' ? 'image/svg+xml' : 'text/plain' };
  } finally { await handle.close(); }
}
