import { chmodSync, existsSync } from 'node:fs';
import { createAgentSessionFromServices, createAgentSessionRuntime, type AgentSession, type CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import type { createSnapCompactResources } from './snapcompact.js';

export interface PiSession { session: AgentSession; close(): Promise<void>; assertHealthy(): void }

/** Owns one SDK runtime. All callers await the same shutdown, including bind failure. */
export async function openPiSession(options: Required<Pick<CreateAgentSessionOptions, 'cwd' | 'agentDir' | 'modelRuntime' | 'settingsManager' | 'sessionManager'>> & CreateAgentSessionOptions,
  resources: Awaited<ReturnType<typeof createSnapCompactResources>>,
  bindings: Parameters<AgentSession['bindExtensions']>[0],
  listener?: Parameters<AgentSession['subscribe']>[0]
): Promise<PiSession> {
  if (!options.sessionManager.isPersisted()) throw new Error('SnapCompact: требуется persisted SessionManager; inMemory не сохраняет архив после перезапуска');
  const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = { cwd, agentDir, modelRuntime: options.modelRuntime, settingsManager: options.settingsManager, resourceLoader: resources.loader, diagnostics: [] };
    return { ...await createAgentSessionFromServices({ ...options, services, sessionManager, sessionStartEvent }), services, diagnostics: [] };
  }, { cwd: options.cwd, agentDir: options.agentDir, sessionManager: options.sessionManager });
  const session = runtime.session;
  const unsubscribe = listener ? session.subscribe(listener) : () => {};
  let invalidated = false;
  runtime.setBeforeSessionInvalidate(() => { unsubscribe(); invalidated = true; });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    const errors: unknown[] = [];
    try { await session.abort(); } catch (error) { errors.push(error); }
    try { await runtime.dispose(); } catch (error) { errors.push(error); }
    finally {
      try { if (!invalidated) { unsubscribe(); session.dispose(); } } catch (error) { errors.push(error); }
      try {
        const file = options.sessionManager.getSessionFile();
        if (file && existsSync(file)) chmodSync(file, 0o600);
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Pi: ошибка завершения сессии');
  })();
  const transform = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) => {
    resources.assertHealthy();
    const result = transform ? await transform(messages, signal) : messages;
    resources.validateRequest(result);
    return result;
  };
  try {
    await session.bindExtensions(bindings);
    resources.assertHealthy();
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], `Pi: ${error instanceof Error ? error.message : String(error)}; cleanup также завершился ошибкой`); }
    throw error;
  }
  return { session, close, assertHealthy: resources.assertHealthy };
}
