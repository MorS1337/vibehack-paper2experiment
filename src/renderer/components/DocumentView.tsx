import { useEffect, useState } from 'react';
import type { ExperimentRun } from '../../shared/types.js';
import { shortHash } from '../lib/format.js';
import { STATUS_META } from '../lib/status.js';
import { ChevronLeftIcon, ChevronRightIcon, FileIcon } from './icons.js';
import { Button, CopyButton, EmptyState } from './ui.js';

export function DocumentView({ run }: { run: ExperimentRun }) {
  const pages = run.source?.pages ?? [];
  const [pageNumber, setPageNumber] = useState(pages[0]?.page ?? 1);

  useEffect(() => {
    if (pages.length === 0) return;
    if (!pages.some((page) => page.page === pageNumber)) {
      setPageNumber(pages[0].page);
    }
  }, [pages, pageNumber]);

  if (!run.source || pages.length === 0) {
    const meta = STATUS_META[run.status];
    return (
      <section className="card document-card" aria-labelledby="document-heading">
        <div className="card-head">
          <div className="card-title-group">
            <h2 id="document-heading">Документ</h2>
            <span className="meta-row">Текст источника</span>
          </div>
        </div>
        <EmptyState
          title={run.source ? 'Текст не извлечён' : 'Источник ещё не импортирован'}
          icon={<FileIcon size={24} />}
        >
          {run.status === 'importing'
            ? 'Идёт извлечение текста. Страницы появятся здесь после завершения импорта.'
            : run.source
              ? 'В источнике нет текстовых страниц. Проверьте PDF или журнал импорта.'
              : `${meta.label}: ${meta.hint}`}
        </EmptyState>
      </section>
    );
  }

  const currentIndex = pages.findIndex((page) => page.page === pageNumber);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const currentPage = pages[safeIndex];

  return (
    <section className="card document-card" aria-labelledby="document-heading">
      <div className="card-head">
        <div className="card-title-group">
          <h2 id="document-heading">Документ</h2>
          <div className="meta-row">
            <span>{pages.length} стр.</span>
            <span title={run.source.sha256}>sha256 {shortHash(run.source.sha256)}</span>
          </div>
        </div>
        <div className="doc-nav">
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setPageNumber(pages[Math.max(0, safeIndex - 1)].page)}
            disabled={safeIndex <= 0}
            aria-label="Предыдущая страница"
            title="Предыдущая страница"
          >
            <ChevronLeftIcon />
          </Button>
          <label className="visually-hidden" htmlFor="page-select">
            Страница документа
          </label>
          <select
            id="page-select"
            className="select page-select"
            value={currentPage.page}
            onChange={(event) => setPageNumber(Number(event.target.value))}
          >
            {pages.map((page) => (
              <option key={page.page} value={page.page}>
                Страница {page.page}
              </option>
            ))}
          </select>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setPageNumber(pages[Math.min(pages.length - 1, safeIndex + 1)].page)}
            disabled={safeIndex >= pages.length - 1}
            aria-label="Следующая страница"
            title="Следующая страница"
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>

      <div className="document-meta">
        <div className="meta-line">
          <span className="meta-key">Исходный файл</span>
          <code className="path-value" title={run.source.original}>{run.source.original}</code>
          <CopyButton text={run.source.original} label="Путь" />
        </div>
        <div className="meta-line">
          <span className="meta-key">Текст</span>
          <code className="path-value" title={run.source.textPath}>{run.source.textPath}</code>
          <CopyButton text={run.source.textPath} label="Путь" />
        </div>
      </div>

      <article
        className="document-text"
        tabIndex={0}
        aria-label={`Текст страницы ${currentPage.page}`}
      >
        {currentPage.text.trim() ? currentPage.text : 'На этой странице текст не распознан.'}
      </article>

      <footer className="document-footer">
        <span>
          Страница {safeIndex + 1} из {pages.length}
        </span>
        <span>Текст извлечён из PDF и не является пересказом</span>
      </footer>
    </section>
  );
}
