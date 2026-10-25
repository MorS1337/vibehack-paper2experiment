import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import baseline from '../../demos/bernoulli-hoeffding/spec.json' with { type: 'json' };
import sourceIdentity from '../../demos/bernoulli-hoeffding/source/source.json' with { type: 'json' };
import { SpecSchema } from '../shared/types.js';
import type { ExperimentRun, ExperimentSpec } from '../shared/types.js';
import { atomicJSON } from './store.js';

export function demoPlan(run: ExperimentRun): ExperimentSpec {
  if (run.source?.sha256 !== sourceIdentity.pdfSha256) throw new Error('Демо-заглушка поддерживает только источник arXiv 1910.02884v1. Нажмите «Заполнить демо» или выберите режим Pi для другой статьи.');
  if (run.input.authorRepo || run.input.dataDir) throw new Error('Фиксированное демо генерирует данные само и не использует авторский репозиторий. Для произвольных данных выберите Pi.');
  const spec = SpecSchema.parse(structuredClone(baseline));
  spec.title = `[ДЕМО / заглушка агента] ${spec.title}`;
  spec.assumptions.unshift('План — явная локальная заглушка для фиксированного кейса, не результат анализа LLM. Свободная задача не интерпретируется. Python и метрики вычисляются реально.');
  return spec;
}

export async function prepareDemoCode(run: ExperimentRun, projectDir: string): Promise<void> {
  const spec = run.spec;
  if (!spec || spec.demo !== 'bernoulli-hoeffding') throw new Error('Демо-заглушка знает только Bernoulli/Hoeffding');
  if (spec.method !== baseline.method || spec.baseline !== baseline.baseline || JSON.stringify(spec.data) !== JSON.stringify(baseline.data)) throw new Error('Заглушка не умеет менять метод, baseline или схему данных. Параметры и лимиты можно редактировать; произвольную методику выполняет Pi.');
  await mkdir(projectDir, { recursive: true });
  const reference = path.join(process.cwd(), 'demos', 'bernoulli-hoeffding', 'reference');
  for (const file of ['main.py', 'experiment.json', 'requirements.txt']) await copyFile(path.join(reference, file), path.join(projectDir, file));
  await atomicJSON(path.join(projectDir, 'config.json'), spec.parameters);
  await atomicJSON(path.join(projectDir, 'implementation.json'), { kind: 'demo-stub', generatedByLLM: false, source: 'bundled reference Python', planVersion: spec.version });
}

export function demoReport(run: ExperimentRun): string {
  return `ДЕМО: план и подготовка кода выполнены заглушками, без LLM. Использован открытый эталонный Python, а не сгенерированная реализация. LocalBackend действительно выполнил эксперимент.\n\nМетрики:\n${JSON.stringify(run.metrics, null, 2)}\n\n${run.verification ?? 'Проверка результата отсутствует'}`;
}
