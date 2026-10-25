import { mkdir, readFile, writeFile, rename, readdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppSettings, ExperimentInput, ExperimentRun, RunEvent } from '../shared/types.js';

export const defaultSettings: AppSettings = { piProvider: '', piModel: '', python: 'python3', whisperBinary: 'whisper-cli', whisperModel: '', sshKeyPath: '' };
export async function atomicJSON(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}
export class Store {
  readonly runs = new Map<string, ExperimentRun>();
  settings = { ...defaultSettings };
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly root: string) {}
  async load(): Promise<void> {
    await mkdir(path.join(this.root, 'experiments'), { recursive: true });
    try {
      const stored: unknown = JSON.parse(await readFile(path.join(this.root, 'settings.json'), 'utf8'));
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('Настройки должны быть JSON-объектом');
      for (const key of Object.keys(defaultSettings) as (keyof AppSettings)[]) {
        const value = (stored as Record<string, unknown>)[key];
        if (value !== undefined && typeof value !== 'string') throw new Error(`Настройка ${key} должна быть строкой`);
        this.settings[key] = typeof value === 'string' ? value : defaultSettings[key];
      }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Не удалось прочитать настройки: ${String(error)}`); }
    for (const name of await readdir(path.join(this.root, 'experiments'))) {
      if (!/^[a-f0-9-]{36}$/.test(name)) continue;
      const file = path.join(this.root, 'experiments', name, 'run.json');
      try {
        const run = JSON.parse(await readFile(file, 'utf8')) as ExperimentRun;
        if (run.id !== name) throw new Error('Некорректный идентификатор');
        run.dir = path.dirname(file);
        this.runs.set(run.id, run);
      } catch (error) { throw new Error(`Не удалось восстановить ${name}: ${String(error)}`); }
    }
  }
  get(id: string): ExperimentRun { const run = this.runs.get(id); if (!run) throw new Error('Эксперимент не найден'); return run; }
  list(): ExperimentRun[] { return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async create(input: ExperimentInput): Promise<ExperimentRun> {
    const id = randomUUID(), now = new Date().toISOString();
    const run: ExperimentRun = { id, createdAt: now, updatedAt: now, title: input.task.slice(0, 80), status: 'draft', input, dir: path.join(this.root, 'experiments', id), planVersion: 0, attempts: 0, artifacts: [] };
    this.runs.set(id, run); await this.patch(id, {}); return run;
  }
  async patch(id: string, patch: Partial<ExperimentRun>): Promise<void> {
    const run = this.get(id); Object.assign(run, patch, { updatedAt: new Date().toISOString() });
    // Serialize immutable snapshots: concurrent log/status writers cannot overwrite newer state.
    const snapshot = JSON.parse(JSON.stringify(run));
    const write = this.writes.then(() => atomicJSON(path.join(run.dir, 'run.json'), snapshot));
    this.writes = write.catch(() => {}); await write;
  }
  async event(id: string, type: RunEvent['type'], message: string): Promise<RunEvent> {
    const run = this.get(id);
    const event: RunEvent = { id: randomUUID(), runId: id, at: new Date().toISOString(), type, message };
    const write = this.writes.then(() => appendFile(path.join(run.dir, 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 }));
    this.writes = write.catch(() => {}); await write; return event;
  }
  async events(id: string): Promise<RunEvent[]> {
    try { return (await readFile(path.join(this.get(id).dir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as RunEvent).slice(-1500); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async saveSettings(settings: AppSettings): Promise<void> { await atomicJSON(path.join(this.root, 'settings.json'), settings); this.settings = settings; }
}
