import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ExperimentRun, SourceDocument, ExperimentSpec } from '../shared/types.js';

const MAX_PDF = 40 * 1024 * 1024;
export function arxivPDF(source: string): URL {
  let id = source.trim();
  if (id.startsWith('http')) {
    const url = new URL(id);
    if (url.protocol !== 'https:' || !['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname)) throw new Error('Поддерживаются только HTTPS-ссылки arXiv');
    id = url.pathname.replace(/^\/(abs|pdf)\//, '').replace(/\.pdf$/, '');
  }
  if (!/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/.test(id)) throw new Error('Некорректная ссылка или идентификатор arXiv');
  return new URL(`https://arxiv.org/pdf/${id}`);
}
async function download(url: URL, signal: AbortSignal): Promise<Uint8Array> {
  for (let redirects = 0; redirects < 5; redirects++) {
    const response = await fetch(url, { signal, redirect: 'manual', headers: { 'User-Agent': 'Paper2Experiment/0.1 (research desktop)' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      url = new URL(response.headers.get('location') ?? '', url);
      if (url.protocol !== 'https:' || !['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname)) throw new Error('Источник перенаправляет за пределы arXiv');
      continue;
    }
    if (!response.ok) throw new Error(`arXiv вернул HTTP ${response.status}`);
    if (!response.body) throw new Error('Источник вернул пустой документ');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_PDF) { await reader.cancel(); throw new Error('PDF превышает лимит импорта 40 MiB'); }
      chunks.push(value);
    }
    const result = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
  throw new Error('Слишком много перенаправлений источника');
}
export async function importSource(run: ExperimentRun, signal: AbortSignal): Promise<SourceDocument> {
  const folder = path.join(run.dir, 'source'); await mkdir(folder, { recursive: true });
  let bytes: Uint8Array;
  if (/^https?:\/\//.test(run.input.source) || !path.isAbsolute(run.input.source)) bytes = await download(arxivPDF(run.input.source), AbortSignal.any([signal, AbortSignal.timeout(90000)]));
  else {
    const info = await stat(run.input.source);
    if (!info.isFile() || info.size > MAX_PDF) throw new Error('Требуется PDF-файл не более 40 MiB');
    bytes = new Uint8Array(await readFile(run.input.source));
  }
  if (!Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'))) throw new Error('Источник не является PDF');
  const original = path.join(folder, 'document.pdf'); await writeFile(original, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // Runs in the dedicated harness utility process, never the renderer/main event loop.
  const document = await getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true }).promise;
  try {
    const pages: SourceDocument['pages'] = [];
    for (let index = 1; index <= document.numPages; index++) {
      signal.throwIfAborted();
      const page = await document.getPage(index); const content = await page.getTextContent();
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
      pages.push({ page: index, text }); page.cleanup();
    }
    if (pages.reduce((sum, page) => sum + page.text.replace(/\s/g, '').length, 0) < 80) throw new Error('В PDF недостаточно извлекаемого текста. OCR и сканы не поддерживаются');
    const textPath = path.join(folder, 'extracted.txt');
    await writeFile(textPath, pages.map(p => `[PAGE ${p.page}]\n${p.text}`).join('\n\n'));
    await writeFile(path.join(folder, 'pages.json'), JSON.stringify(pages, null, 2));
    return { original, textPath, pages, sha256 };
  } finally { await document.destroy(); }
}
export function validateSourceRefs(spec: ExperimentSpec, source: SourceDocument): void {
  const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const ref of spec.sourceRefs) {
    const page = source.pages.find(p => p.page === ref.page);
    if (!page || !normalized(page.text).includes(normalized(ref.quote))) throw new Error(`Цитата не найдена на странице ${ref.page}. Исправьте sourceRefs; ссылки не могут быть выдуманы`);
  }
}
