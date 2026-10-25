import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const VAST_API_BASE = 'https://console.vast.ai/api/v0';

export interface VastCredential {
  key: string;
  source: string;
}

export interface VastApiOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface VastInstance {
  id: number;
  actualStatus: string;
  intendedStatus: string;
  statusMessage?: string;
  sshHost?: string;
  sshPort?: number;
  image?: string;
  label?: string;
  gpuName?: string;
  dphTotal?: number;
}

export class VastApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'VastApiError';
  }
}

/** VAST_API_KEY wins; otherwise read the native CLI key file (never renderer/settings). */
export async function resolveVastCredential(): Promise<VastCredential | null> {
  const fromEnvironment = process.env.VAST_API_KEY?.trim();
  if (fromEnvironment) return { key: fromEnvironment, source: 'VAST_API_KEY' };
  const home = os.homedir();
  const candidates = [
    { file: path.join(home, '.config', 'vastai', 'vast_api_key'), source: '~/.config/vastai/vast_api_key' },
    { file: path.join(home, '.vast_api_key'), source: '~/.vast_api_key' }
  ];
  for (const candidate of candidates) {
    try {
      const key = (await readFile(candidate.file, 'utf8')).trim();
      if (key) return { key, source: candidate.source };
    } catch (error) {
      const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
      if (!missing) throw new Error(`Не удалось прочитать ключ Vast ${candidate.source}: ${String(error)}`);
    }
  }
  return null;
}

function errorDetail(body: unknown): string {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body.slice(0, 500) : '';
  const object = body as Record<string, unknown>;
  for (const key of ['msg', 'error', 'detail', 'message']) {
    if (typeof object[key] === 'string' && object[key]) return String(object[key]).slice(0, 500);
  }
  return '';
}

export class VastApiClient {
  constructor(private readonly apiKey: string, private readonly baseURL = VAST_API_BASE) {}

  private async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', endpoint: string, body?: unknown, options: VastApiOptions = {}): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${this.baseURL}${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal
      });
    } catch (error) {
      throw new VastApiError(0, `Vast API недоступен (${method} ${endpoint}): ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : undefined; }
    catch { parsed = text.slice(0, 2000); }
    if (!response.ok) {
      const detail = errorDetail(parsed) || response.statusText;
      const message = `Vast API ${response.status}: ${detail}`.replaceAll(this.apiKey, '[redacted]');
      throw new VastApiError(response.status, message.slice(0, 800));
    }
    return parsed as T;
  }

  async searchOffers(body: Record<string, unknown>, options?: VastApiOptions): Promise<unknown[]> {
    const result = await this.request<{ offers?: unknown[] }>('POST', '/bundles/', body, options);
    if (!result || !Array.isArray(result.offers)) throw new VastApiError(200, 'Vast API: ответ поиска предложений не содержит offers[]');
    return result.offers;
  }

  async showInstance(id: number, options?: VastApiOptions): Promise<VastInstance | null> {
    const result = await this.request<{ instances?: unknown }>('GET', `/instances/${id}/`, undefined, options);
    const raw = Array.isArray(result?.instances) ? result.instances[0] : result?.instances;
    if (!raw || typeof raw !== 'object') return null;
    const object = raw as Record<string, unknown>;
    const rawId = object.id;
    if (typeof rawId !== 'number' || !Number.isSafeInteger(rawId) || rawId !== id) return null;
    return this.parseInstance(object, rawId);
  }

  private parseInstance(object: Record<string, unknown>, id: number): VastInstance {
    const number = (key: string): number | undefined => {
      const value = object[key];
      return typeof value === 'number' ? value : undefined;
    };
    const dphTotal = number('dph_total');
    return {
      id,
      actualStatus: typeof object.actual_status === 'string' ? object.actual_status : 'unknown',
      intendedStatus: typeof object.intended_status === 'string' ? object.intended_status : 'unknown',
      ...(typeof object.status_msg === 'string' ? { statusMessage: object.status_msg } : {}),
      ...(typeof object.ssh_host === 'string' ? { sshHost: object.ssh_host } : {}),
      ...(typeof object.ssh_port === 'number' ? { sshPort: object.ssh_port } : {}),
      ...(typeof object.image_uuid === 'string' ? { image: object.image_uuid } : {}),
      ...(typeof object.label === 'string' ? { label: object.label } : {}),
      ...(typeof object.gpu_name === 'string' ? { gpuName: object.gpu_name } : {}),
      ...(dphTotal !== undefined ? { dphTotal } : {})
    };
  }

  async createInstance(offerId: number, body: Record<string, unknown>, options?: VastApiOptions): Promise<number> {
    const result = await this.request<{ success?: boolean; new_contract?: unknown; msg?: string }>('PUT', `/asks/${offerId}/`, body, options);
    if (!result || result.success === false) throw new VastApiError(200, `Vast: предложение не принято${result?.msg ? `: ${result.msg}` : ''}`);
    if (typeof result.new_contract !== 'number' || !Number.isSafeInteger(result.new_contract) || result.new_contract <= 0) {
      throw new VastApiError(200, 'Vast: create instance не вернул new_contract');
    }
    return result.new_contract;
  }

  async manageInstance(id: number, body: { state?: 'running' | 'stopped'; label?: string }, options?: VastApiOptions): Promise<void> {
    await this.request<unknown>('PUT', `/instances/${id}/`, body, options);
  }

  async destroyInstance(id: number, options?: VastApiOptions): Promise<void> {
    const result = await this.request<{ success?: boolean; msg?: string }>('DELETE', `/instances/${id}/`, undefined, options);
    if (result && result.success === false) throw new VastApiError(200, `Vast: не удалось уничтожить инстанс${result.msg ? `: ${result.msg}` : ''}`);
  }

  async requestLogs(id: number, options?: VastApiOptions): Promise<string | null> {
    const result = await this.request<{ success?: boolean; result_url?: string }>('PUT', `/instances/request_logs/${id}`, { tail: '1000' }, options);
    return result && typeof result.result_url === 'string' ? result.result_url : null;
  }

  async listSshKeys(options?: VastApiOptions): Promise<{ id: number; key: string }[]> {
    const result = await this.request<unknown>('GET', '/ssh', undefined, options);
    const wrapped = result && typeof result === 'object' && 'keys' in result ? result.keys : undefined;
    const array = Array.isArray(result) ? result : Array.isArray(wrapped) ? wrapped : [];
    return array.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const object = item as Record<string, unknown>;
      return typeof object.id === 'number' && typeof object.key === 'string' ? [{ id: object.id, key: object.key }] : [];
    });
  }

  async registerSshKey(publicKey: string, options?: VastApiOptions): Promise<void> {
    await this.request<unknown>('POST', '/ssh', { ssh_key: publicKey }, options);
  }

  async ping(options?: VastApiOptions): Promise<void> {
    await this.request<unknown>('GET', '/ssh', undefined, options);
  }
}
