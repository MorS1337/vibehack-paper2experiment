import { useEffect, useRef, useState } from "react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist";
import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ExperimentRun } from "../../shared/types.js";

// App lazy-loads this reader as a separate chunk; its PDF.js dependencies stay static.
GlobalWorkerOptions.workerSrc = workerUrl;

function normalizeQuote(text: string): string {
  return text.normalize("NFKC").replace(/\s/g, "").toLowerCase();
}

export default function PaperPane({
  run,
  page,
  quote,
  onPage,
  onQuote,
  onClose,
}: {
  run: ExperimentRun;
  page: number;
  quote: string;
  onPage: (page: number) => void;
  onQuote: (page: number, quote: string) => void;
  onClose: () => void;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState("");
  const [rendering, setRendering] = useState(true);
  const [width, setWidth] = useState(400);
  const [zoom, setZoom] = useState(1);
  const [pageDraft, setPageDraft] = useState(String(page));
  const [selection, setSelection] = useState("");
  const [revision, setRevision] = useState(0);
  const [highlightMissing, setHighlightMissing] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const count = run.source?.pages.length ?? 0;

  useEffect(() => {
    setPageDraft(String(page));
    setSelection("");
  }, [page]);
  useEffect(() => {
    let closed = false;
    let loading: PDFDocumentLoadingTask | undefined;
    setPdf(null);
    setError("");
    void (async () => {
      try {
        if (closed) return;
        loading = getDocument({
          url: `paper2://app/paper/${run.id}.pdf`,
          isEvalSupported: false,
          useSystemFonts: true,
          enableXfa: false,
          disableRange: true,
        });
        const document = await loading.promise;
        if (!closed) setPdf(document);
      } catch (cause) {
        if (!closed)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      closed = true;
      void loading?.destroy();
    };
  }, [run.id, run.source?.sha256]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(200, Math.floor(entries[0].contentRect.width - 32))),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pdf || !canvas.current || !text.current || !sheet.current) return;
    let closed = false;
    let renderTask: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    setRendering(true);
    setError("");
    void (async () => {
      try {
        const documentPage = await pdf.getPage(
          Math.min(Math.max(1, page), pdf.numPages),
        );
        if (closed || !canvas.current || !text.current || !sheet.current)
          return;
        const base = documentPage.getViewport({ scale: 1 });
        const view = documentPage.getViewport({
          scale: (width / base.width) * zoom,
        });
        const ratio = Math.min(devicePixelRatio || 1, 2);
        canvas.current.width = Math.ceil(view.width * ratio);
        canvas.current.height = Math.ceil(view.height * ratio);
        canvas.current.style.width = `${view.width}px`;
        canvas.current.style.height = `${view.height}px`;
        sheet.current.style.width = `${view.width}px`;
        sheet.current.style.height = `${view.height}px`;
        sheet.current.style.setProperty(
          "--total-scale-factor",
          String(view.scale * documentPage.userUnit),
        );
        text.current.replaceChildren();
        renderTask = documentPage.render({
          canvas: canvas.current,
          viewport: view,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
          background: "#ffffff",
        });
        textLayer = new TextLayer({
          textContentSource: documentPage.streamTextContent(),
          container: text.current,
          viewport: view,
        });
        await Promise.all([renderTask.promise, textLayer.render()]);
        if (!closed) {
          setRendering(false);
          setRevision((value) => value + 1);
        }
      } catch (cause) {
        if (!closed) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setRendering(false);
        }
      }
    })();
    return () => {
      closed = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [pdf, page, width, zoom]);

  useEffect(() => {
    const layer = text.current;
    if (!layer || rendering) return;
    layer
      .querySelectorAll(".citation-highlight")
      .forEach((element) => element.classList.remove("citation-highlight"));
    setHighlightMissing(false);
    if (!quote) {
      viewport.current?.scrollTo({ top: 0 });
      return;
    }
    const spans = [...layer.querySelectorAll("span")].filter(
      (span) => span.textContent,
    );
    const lengths = spans.map(
      (span) => normalizeQuote(span.textContent ?? "").length,
    );
    const source = spans
      .map((span) => normalizeQuote(span.textContent ?? ""))
      .join("");
    const target = normalizeQuote(quote);
    const index = source.indexOf(target);
    if (index < 0) {
      setHighlightMissing(true);
      return;
    }
    let position = 0;
    let first: HTMLSpanElement | undefined;
    spans.forEach((span, i) => {
      if (position + lengths[i] > index && position < index + target.length) {
        span.classList.add("citation-highlight");
        first ??= span;
      }
      position += lengths[i];
    });
    first?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [quote, page, revision, rendering]);

  const commitPage = () => {
    const next = Number(pageDraft);
    if (Number.isInteger(next) && next >= 1 && next <= count) onPage(next);
    else setPageDraft(String(page));
  };
  return (
    <aside className="paper-pane" aria-label="Source PDF">
      <header className="paper-pane-heading">
        <div>
          <span className="eyebrow">SOURCE PAPER</span>
          <span
            className="paper-name"
            title={run.source?.title ?? run.input.source}
          >
            {run.source?.title ?? "Imported paper"}
          </span>
        </div>
        <button type="button" onClick={onClose} aria-label="Hide paper">
          ×
        </button>
      </header>
      <div className="paper-toolbar">
        <button
          type="button"
          aria-label="Previous PDF page"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          ‹
        </button>
        <label>
          <input
            aria-label="PDF page"
            inputMode="numeric"
            value={pageDraft}
            onChange={(event) => setPageDraft(event.target.value)}
            onBlur={commitPage}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitPage();
                event.currentTarget.blur();
              }
            }}
          />
          <span>/ {count}</span>
        </label>
        <button
          type="button"
          aria-label="Next PDF page"
          disabled={page >= count}
          onClick={() => onPage(page + 1)}
        >
          ›
        </button>
        <span className="composer-spacer" />
        <select
          aria-label="PDF zoom"
          value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}
        >
          <option value={1}>Fit width</option>
          <option value={1.25}>125%</option>
          <option value={1.5}>150%</option>
          <option value={2}>200%</option>
        </select>
      </div>
      {selection ? (
        <div className="paper-selection">
          <span>{selection.length} selected characters</span>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onQuote(page, selection);
              window.getSelection()?.removeAllRanges();
              setSelection("");
            }}
          >
            Use passage in research ↗
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="paper-error" role="alert">
          <p>Could not render the imported PDF.</p>
          <p>{error}</p>
          <details>
            <summary>Extracted text · page {page}</summary>
            <pre>
              {run.source?.pages.find((item) => item.page === page)?.text}
            </pre>
          </details>
        </div>
      ) : null}
      {highlightMissing ? (
        <p className="paper-notice">
          Page opened. This quotation could not be highlighted in the PDF text
          layer.
        </p>
      ) : null}
      <div
        className="paper-viewport"
        ref={viewport}
        onMouseUp={() => {
          const selected = window.getSelection();
          if (
            selected?.anchorNode &&
            selected.focusNode &&
            text.current?.contains(selected.anchorNode) &&
            text.current.contains(selected.focusNode)
          )
            setSelection(selected.toString().trim().slice(0, 4000));
        }}
      >
        {(!pdf || rendering) && !error ? (
          <div className="paper-loading" role="status">
            Rendering page {page}…
          </div>
        ) : null}
        <div className="pdf-sheet" ref={sheet} aria-busy={rendering}>
          <canvas ref={canvas} aria-label={`Original paper page ${page}`} />
          <div ref={text} className="textLayer" />
        </div>
      </div>
      <footer className="paper-provenance" title={run.source?.sha256}>
        <span>
          Imported original · SHA256 {run.source?.sha256.slice(0, 12)}
        </span>
        <span>Select text to ground a question</span>
      </footer>
    </aside>
  );
}
