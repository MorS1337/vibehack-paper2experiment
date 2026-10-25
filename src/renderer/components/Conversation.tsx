import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  AppAPI,
  ArtifactPreview,
  ConversationBlock,
  ExperimentRun,
} from "../../shared/types.js";
import { RichMessage, SvgFigure } from "./RichMessage.js";
import { errorMessage } from "../lib/api.js";

export function FilePreview({
  api,
  run,
  file,
  caption,
}: {
  api: AppAPI;
  run: ExperimentRun;
  file: string;
  caption?: string;
}) {
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void api
      .artifactPreview(run.id, file)
      .then((value) => {
        if (live) setPreview(value);
      })
      .catch((cause) => {
        if (live) setError(errorMessage(cause));
      });
    return () => {
      live = false;
    };
  }, [api, run.id, file]);
  if (error)
    return (
      <p className="error-text">
        {error}{" "}
        <button type="button" onClick={() => void api.openFolder(run.id)}>
          Open folder
        </button>
      </p>
    );
  if (!preview) return <p className="muted">Loading {file}…</p>;
  return preview.mime === "image/svg+xml" ? (
    <SvgFigure source={preview.text} title={caption ?? file} artifact />
  ) : (
    <details className="file-preview">
      <summary>{caption ?? file}</summary>
      {file.endsWith(".md") ? (
        <RichMessage text={preview.text} />
      ) : (
        <pre>{preview.text}</pre>
      )}
    </details>
  );
}

function Elapsed({
  at,
  duration,
  running,
}: {
  at: number;
  duration?: number;
  running: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return (
    <span className="tool-time">
      {((running ? Math.max(0, now - at) : (duration ?? 0)) / 1000).toFixed(1)}s
    </span>
  );
}

const toolLabels: Record<string, string> = {
  get_experiment: "Review research brief",
  read_source: "Read the paper",
  web_search: "Search the web",
  propose_plan: "Propose protocol",
  read: "Inspect workspace",
  write: "Write implementation",
  edit: "Revise implementation",
  bash: "Run command",
  run_experiment: "Execute & verify",
  show_artifact: "Show research artifact",
};

export const ToolBlock = memo(function ToolBlock({
  block,
  api,
  run,
}: {
  block: ConversationBlock;
  api: AppAPI;
  run: ExperimentRun;
}) {
  const running = block.state === "running";
  let args: Record<string, unknown> = {};
  let output: Record<string, unknown> = {};
  try {
    args = JSON.parse(block.args ?? "{}");
  } catch {
    /* A partial streamed tool call is not yet JSON. */
  }
  try {
    output = JSON.parse(block.text);
  } catch {
    /* Shell output is ordinary text. */
  }
  const target =
    typeof args.command === "string"
      ? args.command
      : typeof args.path === "string"
        ? args.path
        : block.tool === "propose_plan"
          ? "Awaiting scientific review"
          : block.tool === "read_source"
            ? `Pages ${args.first ?? ""}–${args.last ?? ""}`
            : block.tool === "web_search" && typeof args.query === "string"
              ? args.query
              : "";
  const file = typeof output.artifact === "string" ? output.artifact : null;
  return (
    <div className={`tool-block tool-${block.state}`}>
      <details open={running || block.state === "error"}>
        <summary>
          <span
            className={`tool-status ${running ? "working-dot" : ""}`}
            aria-label={block.state}
          >
            {running
              ? ""
              : block.state === "error"
                ? "×"
                : block.state === "cancelled"
                  ? "◌"
                  : "✓"}
          </span>
          <strong title={block.tool}>
            {toolLabels[block.tool ?? ""] ?? block.tool}
          </strong>
          <span className="tool-target">{target}</span>
          {running || block.durationMs !== undefined ? (
            <Elapsed
              at={block.at}
              duration={block.durationMs}
              running={running}
            />
          ) : null}
          <span className="tool-chevron">⌄</span>
        </summary>
        <div className="tool-body">
          {block.args ? (
            <details>
              <summary>{block.tool} · arguments</summary>
              <pre>{block.args}</pre>
            </details>
          ) : null}
          {block.text ? (
            <pre className={block.tool === "edit" ? "edit-output" : ""}>
              {block.text}
            </pre>
          ) : (
            <span className="muted">
              {running ? "Working…" : "No textual output"}
            </span>
          )}
        </div>
      </details>
      {file && block.state === "done" ? (
        <FilePreview
          api={api}
          run={run}
          file={file}
          caption={
            typeof output.caption === "string" ? output.caption : undefined
          }
        />
      ) : null}
      {block.tool === "run_experiment" && block.state === "done"
        ? run.artifacts
            .filter((artifact) => artifact.path.endsWith(".svg"))
            .map((artifact) => (
              <FilePreview
                key={artifact.path}
                api={api}
                run={run}
                file={artifact.path}
              />
            ))
        : null}
    </div>
  );
});

interface Props {
  api: AppAPI;
  run: ExperimentRun;
  blocks: ConversationBlock[];
  active: boolean;
  queued: string[];
  hasMore: boolean;
  loading: boolean;
  onOlder: () => void;
}

export function Conversation({
  api,
  run,
  blocks,
  active,
  queued,
  hasMore,
  loading,
  onOlder,
}: Props) {
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [following, setFollowing] = useState(true);
  const previousHeight = useRef(0);
  const loadingOlder = useRef(false);
  const touchY = useRef(0);
  const pauseFollow = () => {
    follow.current = false;
    setFollowing(false);
  };
  useLayoutEffect(() => {
    const view = scroll.current;
    if (!view) return;
    if (loadingOlder.current) {
      view.scrollTop += view.scrollHeight - previousHeight.current;
      loadingOlder.current = false;
    } else if (follow.current) view.scrollTop = view.scrollHeight;
  }, [blocks, queued, active]);
  useEffect(() => {
    const view = scroll.current;
    if (!view) return;
    const observer = new ResizeObserver(() => {
      if (follow.current) view.scrollTop = view.scrollHeight;
    });
    if (view.firstElementChild) observer.observe(view.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="conversation-shell">
      <div
        className="conversation-scroll"
        ref={scroll}
        tabIndex={0}
        onWheel={(event) => {
          if (event.deltaY < 0) pauseFollow();
        }}
        onTouchStart={(event) => {
          touchY.current = event.touches[0]?.clientY ?? 0;
        }}
        onTouchMove={(event) => {
          const y = event.touches[0]?.clientY ?? 0;
          if (y > touchY.current) pauseFollow();
          touchY.current = y;
        }}
        onKeyDown={(event) => {
          if (["PageUp", "Home", "ArrowUp"].includes(event.key)) pauseFollow();
        }}
        onPointerDown={(event) => {
          if (
            scroll.current &&
            event.clientX >= scroll.current.getBoundingClientRect().right - 12
          )
            pauseFollow();
        }}
        onClickCapture={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("summary, .figure-actions")
          )
            pauseFollow();
        }}
        onScroll={() => {
          const view = scroll.current;
          if (
            view &&
            view.scrollHeight - view.scrollTop - view.clientHeight < 60 &&
            !loadingOlder.current
          ) {
            follow.current = true;
            setFollowing(true);
          }
        }}
      >
        <div className="transcript" aria-label="Conversation">
          {hasMore ? (
            <button
              className="load-older"
              type="button"
              disabled={loading}
              onClick={() => {
                pauseFollow();
                previousHeight.current = scroll.current?.scrollHeight ?? 0;
                loadingOlder.current = true;
                onOlder();
              }}
            >
              {loading ? "Loading…" : "Earlier messages ↑"}
            </button>
          ) : null}
          {!blocks.length ? (
            <div className="conversation-intro">
              <span className="eyebrow">
                {run.input.agentMode === "demo"
                  ? "DEMO · NO MODEL"
                  : run.status === "completed"
                    ? "PREVIOUS RUN"
                    : "RESEARCH SESSION"}
              </span>
              <h1>{run.spec?.title ?? "From a paper to an experiment."}</h1>
              {run.input.agentMode === "demo" ? (
                <p>
                  Fixed plan and reference code. Python and measurements are
                  real; this is not an agent conversation.
                </p>
              ) : run.status === "completed" ? (
                <>
                  <p>
                    This run predates conversation recording. Its measured
                    results are preserved; no transcript has been invented.
                  </p>
                  {run.report ? (
                    <details>
                      <summary>Previous report</summary>
                      <RichMessage text={run.report} />
                    </details>
                  ) : null}
                </>
              ) : (
                <>
                  <p>{run.input.task}</p>
                  <p className="muted">
                    Discuss the method, inspect the evidence, then approve a
                    plan. The agent cannot execute before approval.
                  </p>
                </>
              )}
            </div>
          ) : null}
          {blocks.map((block) =>
            block.kind === "tool" ? (
              <ToolBlock key={block.id} block={block} api={api} run={run} />
            ) : (
              <article
                key={block.id}
                className={`message message-${block.kind} message-${block.state}`}
              >
                <div className="message-label">
                  {block.kind === "user" ? "You" : "Pi"}
                  {block.state === "cancelled" ? (
                    <span>Stopped</span>
                  ) : block.state === "error" ? (
                    <span>Error</span>
                  ) : null}
                </div>
                {block.kind === "user" ? (
                  <div className="user-text">{block.text}</div>
                ) : (
                  <RichMessage
                    text={block.text}
                    streaming={block.state === "streaming"}
                  />
                )}
              </article>
            ),
          )}
          {active ? (
            <div className="agent-working" role="status">
              <span className="working-dot" />
              {run.status === "awaiting_approval"
                ? "Waiting for cloud approval"
                : run.status === "running"
                  ? "Python is running"
                  : "Agent is working"}
            </div>
          ) : null}
          {queued.length ? (
            <div className="queued-messages" aria-label="Queued messages">
              {queued.map((text, index) => (
                <div key={index}>{text}</div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {!following ? (
        <button
          className="jump-latest"
          type="button"
          onClick={() => {
            follow.current = true;
            setFollowing(true);
            if (scroll.current)
              scroll.current.scrollTop = scroll.current.scrollHeight;
          }}
        >
          Latest ↓
        </button>
      ) : null}
    </div>
  );
}
