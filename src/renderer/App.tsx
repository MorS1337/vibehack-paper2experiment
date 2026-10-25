import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  AppAPI,
  AppSettings,
  ConversationBlock,
  ConversationPage,
  ExperimentInput,
  ExperimentRun,
  RunEvent,
  Snapshot,
} from "../shared/types.js";
import { getApi, errorMessage } from "./lib/api.js";
import { SettingsView } from "./components/SettingsView.js";
import { Conversation, FilePreview } from "./components/Conversation.js";
import { NewExperiment } from "./components/NewExperiment.js";
import { RichMessage } from "./components/RichMessage.js";
import { STATUS_META } from "./lib/status.js";
import { PaperContext } from "./lib/paper-context.js";

// PDF rendering is a browser-only, on-demand surface, not part of the initial UI bundle.
const PaperPane = lazy(() => import("./components/PaperPane.js"));
import "./styles.css";

type View = "chat" | "plan" | "files" | "settings" | "new";
const views: {
  id: "chat" | "plan" | "files";
  label: string;
  shortcut: number;
}[] = [
  { id: "chat", label: "Research", shortcut: 1 },
  { id: "plan", label: "Protocol", shortcut: 2 },
  { id: "files", label: "Evidence", shortcut: 3 },
];

function mergeBlocks(
  older: ConversationBlock[],
  newer: ConversationBlock[],
): ConversationBlock[] {
  const map = new Map(older.map((block) => [block.id, block]));
  for (const block of newer) {
    const previous = map.get(block.id);
    map.set(block.id, { ...previous, ...block, at: previous?.at ?? block.at });
  }
  return [...map.values()].sort((a, b) => a.at - b.at);
}

function PlanView({
  run,
  onApprove,
  onChat,
  disabled,
}: {
  run: ExperimentRun;
  onApprove: () => void;
  onChat: () => void;
  disabled: boolean;
}) {
  const paper = useContext(PaperContext);
  const spec = run.spec;
  if (!spec)
    return (
      <div className="empty-inspector">
        <h1>No protocol yet.</h1>
        <p>
          Review the paper with the agent. It will submit a source-grounded
          experiment protocol here before any code can run.
        </p>
        <button type="button" onClick={onChat}>
          Continue research
        </button>
      </div>
    );
  return (
    <div className="inspector-document">
      <div className="document-heading">
        <span className="eyebrow">REPRODUCTION PROTOCOL · V{spec.version}</span>
        <h1>{spec.title}</h1>
        <p>{spec.objective}</p>
      </div>
      <section>
        <h2>Method</h2>
        <RichMessage text={spec.method} />
      </section>
      <section>
        <h2>Data</h2>
        <p>{spec.data.description}</p>
        <p className="muted">
          {spec.data.split} {spec.data.preprocessing}
        </p>
      </section>
      <section>
        <h2>Parameters</h2>
        <dl className="parameter-list">
          {Object.entries(spec.parameters).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>
                {typeof value === "string" ? value : JSON.stringify(value)}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section>
        <h2>Metric &amp; comparison</h2>
        <p>
          <code>{spec.metric.name}</code> · {spec.metric.computation}
        </p>
        <p>
          {spec.metric.comparable
            ? `Published value: ${spec.metric.publishedValue}`
            : "Not a reproduction of a published numerical value."}
        </p>
        <p className="muted">{spec.baseline}</p>
      </section>
      <section>
        <h2>Evidence from the paper</h2>
        {spec.sourceRefs.map((ref, index) => (
          <blockquote key={index}>
            <button
              type="button"
              className="citation-link"
              onClick={() => paper?.cite(ref.page, ref.quote)}
            >
              PAGE {ref.page} ↗
            </button>
            <p>{ref.quote}</p>
          </blockquote>
        ))}
      </section>
      {spec.assumptions.length ? (
        <section>
          <h2>Assumptions</h2>
          <ul>
            {spec.assumptions.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {spec.missing.length ? (
        <section className="plan-blockers">
          <h2>Unresolved</h2>
          <ul>
            {spec.missing.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
          <button type="button" onClick={onChat}>
            Resolve in conversation ↗
          </button>
        </section>
      ) : null}
      <section>
        <h2>Execution boundary</h2>
        <p>
          {run.input.mode} · {spec.limits.timeSeconds}s · $
          {spec.limits.maxHourlyUSD}/hour · ${spec.limits.maxTotalUSD} total
          cloud cap
        </p>
        <p className="muted">
          {spec.requirements.cpuCores} CPU · {spec.requirements.ramGB} GB RAM
          {spec.requirements.gpu
            ? ` · ${spec.requirements.vramGB} GB GPU`
            : " · no GPU"}{" "}
          · {spec.requirements.diskGB} GB disk
        </p>
        <p className="muted">
          Model-provider usage is separate. Local Python and shell tools run as
          your user, not in an OS sandbox. Cloud provisioning requires a second
          approval.
        </p>
      </section>
      <div className="document-actions">
        <button type="button" onClick={onChat}>
          Request changes in chat
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={
            disabled || !!spec.missing.length || run.status === "completed"
          }
          onClick={onApprove}
        >
          {run.approvedPlanVersion === run.planVersion
            ? "Continue approved plan"
            : `Approve v${spec.version} & run`}
        </button>
      </div>
      <details className="raw-spec">
        <summary>Raw ExperimentSpec</summary>
        <pre>{JSON.stringify(spec, null, 2)}</pre>
      </details>
    </div>
  );
}

function FilesView({ api, run }: { api: AppAPI; run: ExperimentRun }) {
  const [file, setFile] = useState<string | null>(null);
  useEffect(() => setFile(null), [run.id]);
  return (
    <div className="inspector-document">
      <div className="document-heading">
        <span className="eyebrow">WORKSPACE & RESULTS</span>
        <h1>
          {run.status === "completed"
            ? "Evidence, not just exit zero."
            : "Experiment files"}
        </h1>
        <button type="button" onClick={() => void api.openFolder(run.id)}>
          Open workspace ↗
        </button>
      </div>
      {run.metrics ? (
        <section>
          <h2>Measured metrics</h2>
          <dl className="parameter-list">
            {Object.entries(run.metrics).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
      {run.verification ? (
        <section>
          <h2>Independent verification</h2>
          <pre className="verification">{run.verification}</pre>
        </section>
      ) : null}
      <section>
        <h2>Files</h2>
        <div className="file-list">
          {[
            "project/main.py",
            "project/config.json",
            "project/plan.json",
            "project/requirements.txt",
            ...run.artifacts.map((artifact) => artifact.path),
          ]
            .filter((value, index, list) => list.indexOf(value) === index)
            .map((path) => (
              <button
                type="button"
                key={path}
                aria-pressed={file === path}
                onClick={() => setFile(path)}
              >
                <span>{path.replace(/^project\//, "")}</span>
                <span className="muted">
                  {run.artifacts
                    .find((artifact) => artifact.path === path)
                    ?.sha256.slice(0, 10)}
                </span>
              </button>
            ))}
        </div>
        {file ? (
          <FilePreview key={file} api={api} run={run} file={file} />
        ) : null}
      </section>
      {run.report ? (
        <section>
          <h2>Agent report</h2>
          <RichMessage text={run.report} />
        </section>
      ) : null}
      {run.command ? (
        <details>
          <summary>Exact rerun command</summary>
          <pre>{run.command}</pre>
        </details>
      ) : null}
    </div>
  );
}

function AppShell({ api }: { api: AppAPI }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>("chat");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [intakeStage, setIntakeStage] = useState<"paper" | "brief">("paper");
  const [paperOpen, setPaperOpen] = useState(true);
  const [paperPage, setPaperPage] = useState(1);
  const [paperQuote, setPaperQuote] = useState("");
  const [paperWidth, setPaperWidth] = useState(44);
  const [briefPassage, setBriefPassage] = useState<{
    page: number;
    quote: string;
  } | null>(null);
  const [blocks, setBlocks] = useState<ConversationBlock[]>([]);
  const [page, setPage] = useState<ConversationPage>({
    blocks: [],
    hasMore: false,
  });
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [queued, setQueued] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [operation, setOperation] = useState(false);
  const [draft, setDraft] = useState("");
  const [delivery, setDelivery] = useState<"steer" | "followUp">("steer");
  const selected = useRef(selectedId);
  const textarea = useRef<HTMLTextAreaElement>(null);
  selected.current = selectedId;
  const refresh = useCallback(async () => {
    const next = await api.snapshot();
    setSnapshot(next);
    setSelectedId((previous) =>
      previous && next.runs.some((run) => run.id === previous)
        ? previous
        : (next.runs[0]?.id ?? null),
    );
  }, [api]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    void refresh().catch((cause) => setError(errorMessage(cause)));
  }, [refresh]);
  useEffect(() => {
    let timer: number | undefined;
    const stopEvents = api.onEvent((event) => {
      if (selected.current === event.runId)
        setEvents((previous) => [...previous, event].slice(-500));
      timer ??= window.setTimeout(() => {
        timer = undefined;
        void refreshRef
          .current()
          .catch((cause) => setError(errorMessage(cause)));
      }, 250);
      if (event.type === "status" && selected.current === event.runId) {
        void api
          .conversation(event.runId)
          .then((result) => {
            if (selected.current === event.runId) {
              setBlocks((previous) => mergeBlocks(previous, result.blocks));
              setPage((current) => ({
                ...result,
                before:
                  current.before === undefined
                    ? result.before
                    : Math.min(current.before, result.before ?? current.before),
                hasMore: current.before === 0 ? false : result.hasMore,
              }));
            }
          })
          .catch((cause) => setError(errorMessage(cause)));
      }
    });
    const stopConversation = api.onConversation((update) => {
      if (selected.current !== update.runId) return;
      setBlocks((previous) => mergeBlocks(previous, update.blocks));
      if (update.queued) setQueued(update.queued);
    });
    return () => {
      stopEvents();
      stopConversation();
      window.clearTimeout(timer);
    };
  }, [api]);
  useEffect(() => {
    setBlocks([]);
    setEvents([]);
    setQueued([]);
    setDraft("");
    setPage({ blocks: [], hasMore: false });
    if (!selectedId) return;
    setLoading(true);
    void Promise.all([api.conversation(selectedId), api.events(selectedId)])
      .then(([result, history]) => {
        if (selected.current !== selectedId) return;
        setBlocks((previous) => mergeBlocks(result.blocks, previous));
        setPage(result);
        setEvents((previous) => [
          ...history,
          ...previous.filter(
            (event) => !history.some((item) => item.id === event.id),
          ),
        ]);
      })
      .catch((cause) => {
        if (selected.current === selectedId) setError(errorMessage(cause));
      })
      .finally(() => {
        if (selected.current === selectedId) setLoading(false);
      });
  }, [api, selectedId]);
  const run = snapshot?.runs.find((item) => item.id === selectedId) ?? null;
  const active = !!run && snapshot?.activeId === run.id;
  const otherActive = !!snapshot?.activeId && !active;
  const showNew = view === "new" || (!run && view !== "settings");
  const newPaper = snapshot?.runs.find((item) => item.id === draftId) ?? null;
  const paperRun = showNew ? newPaper : run;
  useEffect(() => {
    if (run && !run.input.task && view === "chat") {
      setDraftId(run.id);
      setIntakeStage("paper");
      setView("new");
    }
  }, [run?.id, run?.input.task, view]);
  useEffect(() => {
    setPaperPage(1);
    setPaperQuote("");
  }, [paperRun?.id]);
  const cite = useCallback(
    (target: number, quote = "") => {
      if (
        !paperRun?.source ||
        target < 1 ||
        target > paperRun.source.pages.length
      )
        return;
      setPaperPage(target);
      setPaperQuote(quote);
      setPaperOpen(true);
    },
    [paperRun?.id, paperRun?.source?.pages.length],
  );
  const paperNavigation = useMemo(() => ({ cite }), [cite]);
  const newExperiment = () => {
    setDraftId(null);
    setIntakeStage("paper");
    setBriefPassage(null);
    setView("new");
    setError("");
  };
  const discussQuote = (target: number, quote: string) => {
    if (showNew) {
      setBriefPassage({ page: target, quote });
      return;
    }
    setView("chat");
    setDraft(
      (previous) =>
        `${previous ? `${previous}\n\n` : ""}From [p. ${target}](#page=${target}):\n> ${quote.replace(/\n/g, "\n> ")}\n\n`,
    );
    requestAnimationFrame(() => textarea.current?.focus());
  };
  const perform = async (action: () => Promise<unknown>) => {
    setOperation(true);
    setError("");
    try {
      await action();
      await refresh();
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setOperation(false);
    }
  };
  const approvePlan = () => {
    if (run)
      void perform(() => api.execute(run.id)).then((ok) => {
        if (ok) setView("chat");
      });
  };
  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!run || !draft.trim() || operation || otherActive) return;
    const text = draft;
    setDraft("");
    const ok = await perform(() => api.sendMessage(run.id, text, delivery));
    if (!ok) setDraft((current) => current || text);
    textarea.current?.focus();
  };
  const older = async () => {
    if (!run || page.before === undefined) return;
    setLoading(true);
    try {
      const result = await api.conversation(run.id, page.before);
      if (selected.current === run.id) {
        setBlocks((previous) => mergeBlocks(result.blocks, previous));
        setPage(result);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };
  const importPaper = async (source: string) => {
    const imported = await api.importPaper(source);
    setDraftId(imported.id);
    setIntakeStage("paper");
    setSelectedId(imported.id);
    setBriefPassage(null);
    setView("new");
    setPaperOpen(true);
    await refresh();
  };
  const startResearch = async (input: ExperimentInput) => {
    if (!newPaper?.source)
      throw new Error("Import a paper before providing the research brief.");
    try {
      await api.setBrief(newPaper.id, input);
      setView("chat");
      await refresh();
      if (input.agentMode === "pi")
        await api.sendMessage(newPaper.id, input.task, "followUp");
      else await api.plan(newPaper.id);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    }
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setDraftId(null);
        setIntakeStage("paper");
        setBriefPassage(null);
        setView("new");
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        ["1", "2", "3", "5"].includes(event.key)
      ) {
        if (showNew && event.key !== "5") return;
        event.preventDefault();
        setView(
          (
            {
              "1": "chat",
              "2": "plan",
              "3": "files",
              "5": "settings",
            } as Record<string, View>
          )[event.key],
        );
      }
      if (event.key === "Escape" && active && run) {
        event.preventDefault();
        void api
          .cancel(run.id)
          .then(refresh)
          .catch((cause) => setError(errorMessage(cause)));
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [api, active, run, refresh, showNew]);
  const hasPaper = !!paperRun?.source && view !== "settings";
  const splitPaper = hasPaper && paperOpen;
  return (
    <PaperContext.Provider value={paperNavigation}>
      <div className="harness-app">
        <aside className="vertical-rail" aria-label="Workspace navigation">
          <div className="rail-brand">
            <span className="brand-mark" aria-hidden="true" />
            <span>Methodiy AI</span>
          </div>
          <button
            className={`new-session-button${view === "new" ? " selected" : ""}`}
            type="button"
            onClick={newExperiment}
          >
            ＋ New experiment <kbd>⌘N</kbd>
          </button>
          <div className="rail-label">EXPERIMENTS</div>
          <div className="session-list">
            {snapshot?.runs.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`session-tab${item.id === selectedId && (view !== "new" || item.id === draftId) ? " selected" : ""}`}
                onClick={() => {
                  setSelectedId(item.id);
                  if (!item.input.task) {
                    setDraftId(item.id);
                    setIntakeStage("paper");
                    setView("new");
                  } else setView("chat");
                  setError("");
                }}
                title={item.title || "Importing paper"}
              >
                <span
                  className={`session-dot ${snapshot.activeId === item.id ? "working-dot" : item.status === "completed" ? "is-complete" : item.status === "failed" ? "is-error" : ""}`}
                />
                <span>
                  {item.title ||
                    (item.status === "importing"
                      ? "Importing paper…"
                      : "Paper · awaiting brief")}
                </span>
              </button>
            ))}
          </div>
          <div className="rail-bottom">
            <button
              type="button"
              className={view === "settings" ? "selected" : ""}
              onClick={() => setView("settings")}
            >
              <span className="nav-glyph">⚙</span>Settings<kbd>⌘5</kbd>
            </button>
            <span className="rail-status">
              {snapshot
                ? `${snapshot.connections.filter((connection) => connection.state === "ready").length}/${snapshot.connections.length} connected`
                : "Connecting…"}
            </span>
          </div>
        </aside>
        <main className="main-surface">
          <header className="workspace-heading">
            {view === "settings" ? (
              <span className="header-location">Settings</span>
            ) : showNew ? (
              <div className="intake-header">
                <span className="header-location">New experiment</span>
                <ol
                  className="intake-stages"
                  aria-label="New experiment stages"
                >
                  <li
                    aria-current={intakeStage === "paper" ? "step" : undefined}
                  >
                    <button
                      type="button"
                      onClick={() => setIntakeStage("paper")}
                    >
                      <span>01</span> Paper
                    </button>
                  </li>
                  <li
                    aria-current={intakeStage === "brief" ? "step" : undefined}
                  >
                    <button
                      type="button"
                      disabled={!newPaper?.source}
                      onClick={() => setIntakeStage("brief")}
                    >
                      <span>02</span> Research brief
                    </button>
                  </li>
                </ol>
              </div>
            ) : (
              <nav className="workspace-tabs" aria-label="Experiment views">
                {views.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={view === item.id ? "is-current" : ""}
                    aria-current={view === item.id ? "page" : undefined}
                    title={`${item.label} · ⌘${item.shortcut}`}
                    onClick={() => setView(item.id)}
                  >
                    {item.label}
                    {item.id === "plan" && run?.spec ? (
                      <span className="tab-detail">v{run.planVersion}</span>
                    ) : null}
                    {item.id === "files" && run?.verification ? (
                      <span
                        className="evidence-mark"
                        aria-label="Verification available"
                      />
                    ) : null}
                  </button>
                ))}
              </nav>
            )}
            <div className="heading-actions">
              {showNew && !hasPaper ? (
                <span className="header-state">
                  {newPaper?.status === "importing"
                    ? "Importing source…"
                    : "Source first"}
                </span>
              ) : run && !showNew && view !== "settings" ? (
                <span className="header-state" title={run.title}>
                  {active ? "Working" : STATUS_META[run.status].label}
                </span>
              ) : null}
              {hasPaper ? (
                <button
                  type="button"
                  className="paper-toggle"
                  aria-label={paperOpen ? "Hide paper" : "Show paper"}
                  aria-pressed={paperOpen}
                  title={paperOpen ? "Hide source PDF" : "Show source PDF"}
                  onClick={() => setPaperOpen((previous) => !previous)}
                >
                  <span className="paper-toggle-mark" aria-hidden="true">
                    ▤
                  </span>
                  Paper
                </button>
              ) : null}
            </div>
          </header>
          {error ? (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => setError("")}
                aria-label="Dismiss error"
              >
                ×
              </button>
            </div>
          ) : null}
          {otherActive ? (
            <div className="quiet-banner">
              Another experiment is active. You can browse this session; stop
              the active session before executing here.
            </div>
          ) : null}
          {view === "settings" && snapshot ? (
            <div className="settings-scroll">
              <SettingsView
                api={api}
                snapshot={snapshot}
                busy={operation}
                onSave={(settings: AppSettings) =>
                  perform(() => api.saveSettings(settings))
                }
                onRefresh={refresh}
              />
            </div>
          ) : null}
          {view !== "settings" ? (
            <div
              className={`research-stage${splitPaper ? " with-paper" : ""}`}
              style={
                { "--paper-width": `${paperWidth}%` } as React.CSSProperties
              }
            >
              <section className="research-workbench">
                {showNew ? (
                  <div className="document-scroll">
                    <NewExperiment
                      key={draftId ?? "new"}
                      api={api}
                      paper={newPaper}
                      passage={briefPassage}
                      stage={intakeStage}
                      onStageChange={setIntakeStage}
                      onImport={importPaper}
                      onStart={startResearch}
                      onReplace={newExperiment}
                      disabled={!!snapshot?.activeId}
                    />
                  </div>
                ) : null}
                {run && !showNew ? (
                  <>
                    <div className="chat-workspace" hidden={view !== "chat"}>
                      <Conversation
                        key={run.id}
                        api={api}
                        run={run}
                        blocks={blocks}
                        active={active}
                        queued={queued}
                        hasMore={page.hasMore}
                        loading={loading}
                        onOlder={() => void older()}
                      />
                      {run.status === "awaiting_approval" && active ? (
                        <div className="approval-strip cloud-approval">
                          <div>
                            <strong>Cloud execution requires approval</strong>
                            <span>
                              {run.target?.label} · ${run.target?.hourlyUSD}
                              /hour · estimated ${run.target?.estimatedUSD}
                            </span>
                            <span>
                              Offer {run.target?.offerId} · cap $
                              {run.spec?.limits.maxTotalUSD} · cleanup{" "}
                              {run.input.cleanup}
                            </span>
                          </div>
                          <button
                            className="primary-button"
                            type="button"
                            onClick={() =>
                              void perform(() => api.approve(run.id))
                            }
                          >
                            Approve paid instance
                          </button>
                        </div>
                      ) : null}
                      {run.spec &&
                      run.status === "ready" &&
                      !active &&
                      run.approvedPlanVersion !== run.planVersion ? (
                        <div className="approval-strip">
                          <span>
                            Protocol v{run.planVersion} is ready for scientific
                            review.
                          </span>
                          <button type="button" onClick={() => setView("plan")}>
                            Review protocol ↗
                          </button>
                        </div>
                      ) : null}
                      {run.cleanupRequired ||
                      run.instanceId ||
                      run.provisioningUncertain ? (
                        <div className="approval-strip cloud-approval">
                          <span>
                            Cloud resources may still be billing. Export and
                            cleanup are required.
                          </span>
                          <button
                            type="button"
                            disabled={active || operation}
                            onClick={() =>
                              void perform(() => api.cleanup(run.id))
                            }
                          >
                            Export &amp; clean up
                          </button>
                        </div>
                      ) : null}
                      {!active && run.pendingInputs?.length ? (
                        <div className="pending-inputs">
                          <span>
                            Unsent input · preserved after interruption
                          </span>
                          {run.pendingInputs.map((input) => (
                            <div key={input.id}>
                              <span>{input.text}</span>
                              <button
                                type="button"
                                disabled={operation || otherActive}
                                onClick={() =>
                                  void perform(() =>
                                    api.sendMessage(
                                      run.id,
                                      input.text,
                                      input.delivery,
                                      input.id,
                                    ),
                                  )
                                }
                              >
                                Resend ↗
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {run.input.agentMode === "pi" ? (
                        <form
                          className="chat-composer"
                          onSubmit={(event) => void send(event)}
                        >
                          <textarea
                            ref={textarea}
                            aria-label="Research message"
                            placeholder={
                              active
                                ? "Clarify an assumption or queue the next research question…"
                                : "Question a claim, refine the protocol, or interpret the evidence…"
                            }
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            rows={2}
                            maxLength={30000}
                            disabled={otherActive}
                            onKeyDown={(event) => {
                              if (
                                event.key === "Enter" &&
                                !event.shiftKey &&
                                !event.nativeEvent.isComposing
                              ) {
                                event.preventDefault();
                                void send();
                              }
                            }}
                          />
                          <div className="composer-footer">
                            <button
                              className="model-button"
                              type="button"
                              onClick={() => setView("settings")}
                              title="Model and provider settings"
                            >
                              {snapshot?.settings.piProvider || "Auto"} /{" "}
                              {snapshot?.settings.piModel || "available model"}
                            </button>
                            <span className="composer-spacer" />
                            {active ? (
                              <>
                                <select
                                  aria-label="Message delivery"
                                  value={delivery}
                                  onChange={(event) =>
                                    setDelivery(
                                      event.target.value as
                                        | "steer"
                                        | "followUp",
                                    )
                                  }
                                >
                                  <option value="steer">
                                    Steer at next boundary
                                  </option>
                                  <option value="followUp">
                                    Queue after current work
                                  </option>
                                </select>
                                <button
                                  className="stop-button"
                                  type="button"
                                  disabled={operation}
                                  onClick={() =>
                                    void perform(() => api.cancel(run.id))
                                  }
                                >
                                  ■ Stop <kbd>esc</kbd>
                                </button>
                              </>
                            ) : (
                              <span className="composer-hint">
                                ↵ send · ⇧↵ newline
                              </span>
                            )}
                            <button
                              className="send-button"
                              type="submit"
                              disabled={
                                !draft.trim() || operation || otherActive
                              }
                              aria-label={
                                active ? "Queue message" : "Send message"
                              }
                            >
                              ↑
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div className="demo-controls">
                          <span>
                            Demo uses fixed stubs, not a conversational model.
                          </span>
                          <button
                            type="button"
                            disabled={active || operation}
                            onClick={() =>
                              void perform(() =>
                                run.spec
                                  ? api.execute(run.id)
                                  : api.plan(run.id),
                              )
                            }
                          >
                            {run.spec ? "Run real Python" : "Prepare demo plan"}
                          </button>
                          {active ? (
                            <button
                              type="button"
                              onClick={() =>
                                void perform(() => api.cancel(run.id))
                              }
                            >
                              Stop
                            </button>
                          ) : null}
                        </div>
                      )}
                      <details className="diagnostic-log">
                        <summary>
                          Operational log · {events.length} events
                        </summary>
                        <div>
                          {events.map((event) => (
                            <div key={event.id}>
                              <time>
                                {new Date(event.at).toLocaleTimeString()}
                              </time>
                              <span>{event.type}</span>
                              <pre>{event.message}</pre>
                            </div>
                          ))}
                        </div>
                      </details>
                    </div>
                    {view === "plan" ? (
                      <div className="document-scroll">
                        <PlanView
                          run={run}
                          onApprove={approvePlan}
                          onChat={() => {
                            setView("chat");
                            textarea.current?.focus();
                          }}
                          disabled={operation || !!snapshot?.activeId}
                        />
                      </div>
                    ) : null}
                    {view === "files" ? (
                      <div className="document-scroll">
                        <FilesView api={api} run={run} />
                      </div>
                    ) : null}
                  </>
                ) : null}
              </section>
              {splitPaper && paperRun ? (
                <>
                  <div
                    className="paper-divider"
                    role="separator"
                    aria-label="PDF pane width"
                    aria-orientation="vertical"
                    aria-valuemin={30}
                    aria-valuemax={65}
                    aria-valuenow={Math.round(paperWidth)}
                    tabIndex={0}
                    onPointerDown={(event) =>
                      event.currentTarget.setPointerCapture(event.pointerId)
                    }
                    onPointerMove={(event) => {
                      if (
                        !event.currentTarget.hasPointerCapture(event.pointerId)
                      )
                        return;
                      const rect =
                        event.currentTarget.parentElement!.getBoundingClientRect();
                      setPaperWidth(
                        Math.min(
                          65,
                          Math.max(
                            30,
                            ((rect.right - event.clientX) / rect.width) * 100,
                          ),
                        ),
                      );
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key === "ArrowLeft" ||
                        event.key === "ArrowRight"
                      ) {
                        event.preventDefault();
                        setPaperWidth((previous) =>
                          Math.min(
                            65,
                            Math.max(
                              30,
                              previous + (event.key === "ArrowLeft" ? 2 : -2),
                            ),
                          ),
                        );
                      }
                    }}
                  />
                  <Suspense
                    fallback={
                      <aside className="paper-pane paper-loading">
                        Loading source reader…
                      </aside>
                    }
                  >
                    <PaperPane
                      key={paperRun.id}
                      run={paperRun}
                      page={paperPage}
                      quote={paperQuote}
                      onPage={(page) => {
                        setPaperPage(page);
                        setPaperQuote("");
                      }}
                      onQuote={discussQuote}
                      onClose={() => setPaperOpen(false)}
                    />
                  </Suspense>
                </>
              ) : null}
            </div>
          ) : null}
        </main>
      </div>
    </PaperContext.Provider>
  );
}

export function App() {
  const api = getApi();
  return api ? (
    <AppShell api={api} />
  ) : (
    <div className="bridge-unavailable">
      <h1>Open Methodiy AI in Electron.</h1>
      <p>The browser preview cannot access the research harness.</p>
      <code>npm run dev</code>
    </div>
  );
}
