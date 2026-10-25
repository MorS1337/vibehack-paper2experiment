import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getAgentDir, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { PiLoginMethod, PiLoginNotice, PiLoginPrompt, PiLoginState, PiProvider } from '../shared/types.js';

type Interaction = Parameters<ModelRuntime['login']>[2];
type Prompt = Parameters<Interaction['prompt']>[0];
const NATIVE_LOGIN_HELP = 'Для API-ключа или ручного кода откройте терминал, запустите pi и выполните /login. Вводите секреты только там; либо настройте штатную переменную окружения провайдера перед запуском приложения. Затем обновите статусы в настройках.';
interface Login {
  state: PiLoginState;
  controller: AbortController;
  done: Promise<void>;
  answer?: { id: string; resolve: (value: string) => void; reject: (error: Error) => void };
}

/** Adapts Pi's provider-owned login flows; credentials never enter snapshots or events. */
export class PiAuth {
  private login?: Login;
  constructor(
    private readonly createRuntime = (signal: AbortSignal) => ModelRuntime.create({ signal }),
    private readonly deviceIdPath = path.join(getAgentDir(), 'paper2-device-id')
  ) {}
  get busy(): boolean { return this.login?.state.status === 'pending'; }

  private async deviceId(): Promise<string> {
    await mkdir(path.dirname(this.deviceIdPath), { recursive: true });
    try { await writeFile(this.deviceIdPath, randomUUID(), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const id = (await readFile(this.deviceIdPath, 'utf8')).trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid installation ID');
    return id;
  }

  async providers(): Promise<PiProvider[]> {
    const runtime = await this.createRuntime(AbortSignal.timeout(15_000));
    return runtime.getProviders().map(provider => ({
      id: provider.id,
      name: provider.name,
      configured: runtime.getProviderAuthStatus(provider.id).configured,
      methods: [
        ...(provider.auth.oauth ? [{ type: 'oauth' as const, label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name }] : []),
        ...(provider.auth.apiKey?.login ? [{ type: 'api_key' as const, label: provider.auth.apiKey.name }] : [])
      ],
      models: runtime.getModels(provider.id).map(model => ({ id: model.id, name: model.name }))
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  start(provider: string, method: PiLoginMethod): PiLoginState {
    if (this.busy) throw new Error('Уже выполняется вход в Pi');
    if (method !== 'oauth') throw new Error(NATIVE_LOGIN_HELP);
    const login: Login = {
      state: { id: randomUUID(), provider, status: 'pending', notices: [] },
      controller: new AbortController(), done: Promise.resolve()
    };
    this.login = login;
    login.done = this.run(login, method);
    return this.state(login.state.id);
  }

  private async run(login: Login, method: PiLoginMethod): Promise<void> {
    const timeout = setTimeout(() => login.controller.abort(new Error('Время входа истекло')), 10 * 60_000);
    try {
      const runtime = await this.createRuntime(login.controller.signal);
      login.controller.signal.throwIfAborted();
      const provider = runtime.getProvider(login.state.provider);
      if (!provider?.auth.oauth) {
        throw new Error('Unsupported login method');
      }
      const deviceId = method === 'oauth' ? await this.deviceId() : undefined;
      await runtime.login(provider.id, method, {
        signal: login.controller.signal,
        prompt: prompt => this.prompt(login, prompt),
        notify: notice => {
          if (login.controller.signal.aborted) return;
          login.state.notices = [...login.state.notices.slice(-19), structuredClone(notice) as PiLoginNotice];
        }
      }, { agentName: 'Methodiy AI', getDeviceId: () => deviceId! });
      login.state.status = 'completed';
    } catch {
      // Provider exceptions may contain entered secrets or token responses. Never forward them.
      login.state.status = login.controller.signal.aborted ? 'cancelled' : 'failed';
      if (login.state.status === 'failed') login.state.error = `Pi не завершил вход. Проверьте доступность провайдера. ${NATIVE_LOGIN_HELP}`;
    } finally {
      clearTimeout(timeout);
      login.answer?.reject(new Error('Вход завершён'));
      login.answer = undefined;
      login.state.prompt = undefined;
      login.state.notices = [];
    }
  }

  private prompt(login: Login, prompt: Prompt): Promise<string> {
    const signal = prompt.signal ? AbortSignal.any([login.controller.signal, prompt.signal]) : login.controller.signal;
    signal.throwIfAborted();
    // A manual-code prompt races the browser callback in some OAuth providers.
    // Keep that callback alive, but never expose a credential-entry prompt to React.
    if (prompt.type !== 'select') {
      if (prompt.type !== 'manual_code') return Promise.reject(new Error(NATIVE_LOGIN_HELP));
      login.state.notices = [...login.state.notices.slice(-19), { type: 'info', message: `Можно завершить вход через браузер. Если нужен ручной код, отмените вход здесь. ${NATIVE_LOGIN_HELP}` }];
      const { promise, reject } = Promise.withResolvers<string>();
      const abort = () => reject(new Error('Запрос отменён'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      return promise;
    }
    const id = randomUUID();
    const publicPrompt: PiLoginPrompt = { id, type: prompt.type, message: prompt.message };
    publicPrompt.options = prompt.options.map(option => ({ ...option }));
    login.state.prompt = publicPrompt;
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const clear = () => {
      signal.removeEventListener('abort', abort);
      if (login.answer?.id === id) { login.answer = undefined; login.state.prompt = undefined; }
    };
    const abort = () => { clear(); reject(new Error('Запрос отменён')); };
    login.answer = { id, resolve: value => { clear(); resolve(value); }, reject: error => { clear(); reject(error); } };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return promise;
  }

  state(id: string): PiLoginState {
    if (!this.login || this.login.state.id !== id) throw new Error('Сессия входа не найдена');
    return structuredClone(this.login.state);
  }

  respond(id: string, promptId: string, value: string): void {
    const state = this.state(id);
    const answer = this.login?.answer;
    if (state.status !== 'pending' || !answer || answer.id !== promptId) throw new Error('Запрос входа уже завершён');
    if (state.prompt?.type !== 'select' || !state.prompt.options?.some(option => option.id === value)) throw new Error('Недопустимый вариант');
    answer.resolve(value);
  }

  async cancel(id: string): Promise<void> {
    this.state(id);
    this.login!.controller.abort(new Error('Отменено пользователем'));
    await this.login!.done;
  }

  authLink(id: string, url: string): string {
    const state = this.state(id);
    const allowed = state.status === 'pending' && state.notices.some(notice =>
      notice.type === 'auth_url' ? notice.url === url : notice.type === 'device_code' ? notice.verificationUri === url : notice.type === 'info' && notice.links?.some(link => link.url === url));
    const parsed = new URL(url);
    if (!allowed || parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Недопустимая ссылка авторизации');
    return parsed.href;
  }

  async shutdown(): Promise<void> { if (this.busy) await this.cancel(this.login!.state.id); }
}
