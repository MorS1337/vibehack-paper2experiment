import {
  createContext,
  lazy,
  memo,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import DOMPurify from "dompurify";
import { PaperContext } from "../lib/paper-context.js";
const MathMarkdown = lazy(() => import("./MathMarkdown.js"));

const SVG_LIMIT = 512 * 1024;

export function safeSvg(source: string): string {
  if (source.length > SVG_LIMIT || /<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error(
      "SVG is too large or contains a document/entity declaration",
    );
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  if (
    parsed.querySelector("parsererror") ||
    parsed.documentElement.localName !== "svg"
  )
    throw new Error("Incomplete or invalid SVG");
  const clean = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [
      "script",
      "foreignObject",
      "animate",
      "animateMotion",
      "animateTransform",
      "set",
      "a",
      "image",
    ],
    FORBID_ATTR: ["href", "xlink:href"],
    RETURN_TRUSTED_TYPE: false,
  });
  const document = new DOMParser().parseFromString(clean, "image/svg+xml");
  const root = document.documentElement;
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      // Preserve local gradients, but reject resource-bearing CSS rather than misdraw it.
      const urls = attribute.value.matchAll(/url\s*\(([^)]*)\)/gi);
      if (
        [...urls].some(
          (match) => !/^\s*['"]?#[\w.-]+['"]?\s*$/.test(match[1]),
        ) ||
        /@import|javascript:|data:/i.test(attribute.value)
      )
        throw new Error("External SVG resources are not supported");
    }
  }
  for (const style of root.querySelectorAll("style")) {
    const css = style.textContent ?? "";
    if (
      /@import|javascript:|data:/i.test(css) ||
      [...css.matchAll(/url\s*\(([^)]*)\)/gi)].some(
        (match) => !/^\s*['"]?#[\w.-]+['"]?\s*$/.test(match[1]),
      )
    )
      throw new Error("External SVG styles are not supported");
  }
  if (!root.hasAttribute("fill")) root.setAttribute("fill", "currentColor");
  root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const theme = getComputedStyle(window.document.documentElement);
  const variables = [
    "fg",
    "muted",
    "border",
    "surface",
    "accent",
    "success",
    "warning",
    "error",
    "c1",
    "c2",
    "c3",
    "c4",
    "c5",
    "c6",
  ];
  root.setAttribute(
    "style",
    `color:${theme.getPropertyValue("--fg")};` +
      variables
        .map((name) => `--${name}:${theme.getPropertyValue(`--${name}`)};`)
        .join(""),
  );
  if (
    !root.hasAttribute("viewBox") &&
    (!root.hasAttribute("width") || !root.hasAttribute("height"))
  )
    root.setAttribute("viewBox", "0 0 800 400");
  return new XMLSerializer().serializeToString(root);
}

export const SvgFigure = memo(function SvgFigure({
  source,
  title = "Research figure",
  artifact = false,
}: {
  source: string;
  title?: string;
  artifact?: boolean;
}) {
  const [showSource, setShowSource] = useState(false);
  const [themeVersion, setThemeVersion] = useState(0);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setThemeVersion((value) => value + 1);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const prepared = useMemo(() => {
    try {
      const clean = safeSvg(source);
      return {
        uri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(clean)}`,
        error: "",
      };
    } catch (error) {
      return {
        uri: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [source, themeVersion]);
  return (
    <figure className="svg-figure">
      <figcaption>
        <span className="figure-caption">
          <span className="eyebrow">
            {artifact ? "SAVED ARTIFACT" : "AGENT ILLUSTRATION"}
          </span>
          <span>{title}</span>
        </span>
        <span className="figure-actions">
          <button
            type="button"
            onClick={() => setShowSource((value) => !value)}
            aria-pressed={showSource}
          >
            {showSource ? "Preview" : "Source"}
          </button>
          {prepared.uri ? (
            <a href={prepared.uri} download="figure.svg">
              Save SVG
            </a>
          ) : null}
        </span>
      </figcaption>
      {showSource ? (
        <pre>{source}</pre>
      ) : prepared.error ? (
        <p className="error-text" role="alert">
          {prepared.error}
        </p>
      ) : (
        <img src={prepared.uri} alt={title} loading="lazy" />
      )}
    </figure>
  );
});

interface RenderState {
  text: string;
  streaming: boolean;
  onError: (message: string) => void;
}
const RenderContext = createContext<RenderState | null>(null);

function MarkdownCode({
  className,
  children,
  node,
}: {
  className?: string;
  children?: ReactNode;
  node?: {
    position?: { start: { offset?: number }; end: { offset?: number } };
  };
}) {
  const state = useContext(RenderContext);
  if (!state) throw new Error("Markdown code requires its render context");
  const source = String(children).replace(/\n$/, "");
  if (className === "language-svg") {
    const raw = state.text.slice(
      node?.position?.start.offset,
      node?.position?.end.offset,
    );
    const closed = /\n(?:`{3,}|~{3,})\s*$/.test(raw);
    return state.streaming && !closed ? (
      <div className="generating-figure" role="status">
        Drawing SVG…
      </div>
    ) : (
      <SvgFigure source={source} />
    );
  }
  if (className === "language-diff")
    return (
      <pre className="diff-code">
        {source.split("\n").map((line, index) => (
          <span
            key={index}
            className={
              line.startsWith("+")
                ? "diff-add"
                : line.startsWith("-")
                  ? "diff-remove"
                  : ""
            }
          >
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    );
  return <code className={className}>{children}</code>;
}

function MarkdownLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  const state = useContext(RenderContext);
  const paper = useContext(PaperContext);
  const page = /^#page=(\d+)$/.exec(href ?? "");
  if (page && paper)
    return (
      <button
        type="button"
        className="citation-link"
        onClick={() => paper.cite(Number(page[1]))}
      >
        {children} ↗
      </button>
    );
  return href?.startsWith("https://") ? (
    <a
      className="text-link"
      href={href}
      onClick={(event) => {
        event.preventDefault();
        void window.paper2
          .openExternal(href)
          .catch((cause) =>
            state?.onError(
              cause instanceof Error ? cause.message : String(cause),
            ),
          );
      }}
    >
      {children}
    </a>
  ) : (
    <span title={href}>{children}</span>
  );
}

// Stable component identities keep figure previews mounted while later tokens arrive.
const markdownComponents: Components = {
  img: ({ alt }) => (
    <span className="muted">[Image: {alt ?? "external image not loaded"}]</span>
  ),
  a: MarkdownLink,
  code: MarkdownCode,
  pre: ({ children }) => <div className="code-block">{children}</div>,
};

export const RichMessage = memo(function RichMessage({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const [linkError, setLinkError] = useState("");
  const state = useMemo(
    () => ({ text, streaming, onError: setLinkError }),
    [text, streaming],
  );
  const hasMath = /\$\$|\$[^$\n]+\$|\\\(|\\\[|```math/.test(text);
  return (
    <RenderContext.Provider value={state}>
      <div className={`prose${streaming ? " is-streaming" : ""}`}>
        {hasMath ? (
          <Suspense fallback={<pre>{text}</pre>}>
            <MathMarkdown text={text} components={markdownComponents} />
          </Suspense>
        ) : (
          <Markdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={markdownComponents}
          >
            {text}
          </Markdown>
        )}
        {linkError ? (
          <p className="error-text" role="alert">
            {linkError}
          </p>
        ) : null}
      </div>
    </RenderContext.Provider>
  );
});
