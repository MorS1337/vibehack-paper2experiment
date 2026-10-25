import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  AppAPI,
  ExperimentInput,
  ExperimentRun,
} from "../../shared/types.js";
import { useVoiceTask } from "../hooks/useVoiceTask.js";
import { errorMessage } from "../lib/api.js";

// A decorative, deterministic field: not a chart and not represented as measured data.
const fieldDots = Array.from({ length: 150 }, (_, i) => {
  const column = i % 30,
    row = Math.floor(i / 30);
  const x = 12 + column * 22;
  const y = 37 + row * 14 + Math.sin(column / 4 + row * 0.55) * (10 + row * 3);
  return {
    x,
    y,
    opacity: 0.12 + 0.5 * Math.sin(((column + 1) / 31) * Math.PI),
  };
});

function ResearchField() {
  return (
    <svg className="research-field" viewBox="0 0 680 130" aria-hidden="true">
      <g fill="currentColor">
        {fieldDots.map((dot, index) => (
          <circle
            key={index}
            cx={dot.x}
            cy={dot.y}
            r={index % 9 === 0 ? 1.4 : 0.8}
            opacity={dot.opacity}
          />
        ))}
      </g>
    </svg>
  );
}

interface Props {
  api: AppAPI;
  paper: ExperimentRun | null;
  disabled: boolean;
  onImport: (source: string) => Promise<void>;
  onStart: (input: ExperimentInput) => Promise<void>;
  onReplace: () => void;
  passage: { page: number; quote: string } | null;
  stage: "paper" | "brief";
  onStageChange: (stage: "paper" | "brief") => void;
}

export function NewExperiment({
  api,
  paper,
  passage,
  onImport,
  onStart,
  onReplace,
  disabled,
  stage,
  onStageChange: setStage,
}: Props) {
  const [source, setSource] = useState(paper?.input.source ?? "");
  const [objective, setObjective] = useState("");
  const [context, setContext] = useState("");
  const [mode, setMode] = useState<ExperimentInput["mode"]>("local");
  const [agentMode, setAgentMode] =
    useState<ExperimentInput["agentMode"]>("pi");
  const [time, setTime] = useState(300);
  const [hourly, setHourly] = useState(0);
  const [total, setTotal] = useState(0);
  const [repo, setRepo] = useState("");
  const [data, setData] = useState("");
  const [cleanup, setCleanup] = useState<ExperimentInput["cleanup"]>("destroy");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const voice = useVoiceTask(api, (transcript) =>
    setContext((value) => (value ? `${value}\n${transcript}` : transcript)),
  );
  useEffect(() => {
    if (paper) setSource(paper.input.source);
  }, [paper?.id]);
  const consumedPassage = useRef<Props["passage"]>(null);
  useEffect(() => {
    if (!passage || consumedPassage.current === passage) return;
    consumedPassage.current = passage;
    setContext(
      (previous) =>
        `${previous ? `${previous}\n\n` : ""}From [p. ${passage.page}](#page=${passage.page}):\n> ${passage.quote.replace(/\n/g, "\n> ")}`,
    );
    setStage("brief");
  }, [passage]);
  const importing = paper?.status === "importing";
  const choose = async (kind: "pdf" | "data") => {
    try {
      const value = await api.choose(kind);
      if (value) kind === "pdf" ? setSource(value) : setData(value);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const importSource = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setError("");
    try {
      await onImport(source);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  };
  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (!paper?.source) return;
    setWorking(true);
    setError("");
    try {
      const task = `Research objective:\n${objective.trim()}${context.trim() ? `\n\nAdditional context and constraints:\n${context.trim()}` : ""}`;
      await onStart({
        agentMode,
        source: paper.input.source,
        task,
        mode: agentMode === "demo" ? "local" : mode,
        timeSeconds: time,
        maxHourlyUSD: hourly,
        maxTotalUSD: total,
        authorRepo: repo || undefined,
        dataDir: data || undefined,
        cleanup,
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className={`new-experiment intake-${stage}`}>
      {stage === "paper" ? (
        <>
          <ResearchField />
          <div className="new-heading">
            <span className="eyebrow">PAPER2EXPERIMENT</span>
            <h1>Start with the paper.</h1>
            <p>
              First, bring in the source. Then tell us which claim to reproduce
              and what a convincing result would look like.
            </p>
          </div>
          {!paper?.source ? (
            <form onSubmit={(event) => void importSource(event)}>
              <label className="field-label" htmlFor="new-source">
                arXiv link
              </label>
              <div className="source-row">
                <input
                  id="new-source"
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  placeholder="https://arxiv.org/abs/…"
                  disabled={importing || working}
                  required
                />
                <button
                  type="button"
                  disabled={importing || working}
                  onClick={() => void choose("pdf")}
                >
                  Local PDF
                </button>
              </div>
              <p className="input-guidance">
                Accepts an arXiv abstract/PDF link or a local text PDF. We
                preserve the original, its page numbers, and SHA256. No model
                call during import.
              </p>
              {error || paper?.error ? (
                <p className="error-text" role="alert">
                  {error || paper?.error}
                </p>
              ) : null}
              <div className="intake-actions">
                <button
                  className="primary-button"
                  type="submit"
                  disabled={disabled || importing || working || !source.trim()}
                >
                  {importing || working ? "Importing paper…" : "Import paper →"}
                </button>
                {importing && paper ? (
                  <button
                    type="button"
                    onClick={() =>
                      void api
                        .cancel(paper.id)
                        .catch((cause) => setError(errorMessage(cause)))
                    }
                  >
                    Cancel import
                  </button>
                ) : null}
              </div>
              {paper?.status === "failed" || paper?.status === "cancelled" ? (
                <button type="button" onClick={onReplace}>
                  Choose another paper
                </button>
              ) : null}
              {!paper ? (
                <button
                  className="example-link"
                  type="button"
                  onClick={() =>
                    setSource("https://arxiv.org/abs/1910.02884v1")
                  }
                >
                  Use the concentration-inequalities example
                </button>
              ) : null}
            </form>
          ) : (
            <div className="paper-imported">
              <span className="eyebrow">SOURCE VERIFIED</span>
              <h2>{paper.source.title ?? paper.title}</h2>
              <p>{paper.source.pages.length} pages · original PDF preserved</p>
              <p className="source-address">{paper.input.source}</p>
              <p className="source-hash" title={paper.source.sha256}>
                SHA256 {paper.source.sha256.slice(0, 20)}…
              </p>
              <div className="intake-actions">
                <button
                  className="primary-button"
                  type="button"
                  disabled={disabled}
                  onClick={() => setStage("brief")}
                >
                  Use this paper →
                </button>
                <button type="button" onClick={onReplace}>
                  Change paper
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="new-heading">
            <span className="eyebrow">RESEARCH BRIEF</span>
            <h1>What should we reproduce?</h1>
            <p>
              The paper stays beside your work. Be specific about the claim,
              figure, or experiment—not how the agent should write code.
            </p>
            <div className="brief-paper-reference">
              {paper?.source?.title ?? paper?.title}{" "}
              <span>· {paper?.source?.pages.length} pages</span>
            </div>
          </div>
          <form onSubmit={(event) => void start(event)}>
            <label className="field-label" htmlFor="new-objective">
              Reproduction objective
            </label>
            <textarea
              id="new-objective"
              rows={3}
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              placeholder="Which claim, figure, or table do you want to check? What would count as a successful reproduction?"
              required
              maxLength={12000}
            />
            <label className="field-label" htmlFor="new-context">
              Additional context <span className="muted">· optional</span>
            </label>
            <textarea
              id="new-context"
              rows={4}
              value={context}
              onChange={(event) => setContext(event.target.value)}
              placeholder="Your hypotheses, available data, author code, acceptable simplifications, or constraints the agent should respect…"
              maxLength={16000}
            />
            <div className="composer-tools">
              <button
                type="button"
                disabled={
                  voice.phase === "requesting" || voice.phase === "transcribing"
                }
                onClick={() =>
                  void (voice.phase === "recording"
                    ? voice.stop()
                    : voice.start())
                }
              >
                {voice.phase === "recording"
                  ? "Stop recording"
                  : voice.phase === "transcribing"
                    ? "Transcribing…"
                    : "Dictate context"}
              </button>
              {paper?.input.source.includes("1910.02884") ? (
                <button
                  type="button"
                  onClick={() => {
                    setObjective(
                      "Independently check the Bernoulli–Hoeffding one-sided bound with the built-in demo artifact contract. This is a theorem check, not reproduction of a published numerical value.",
                    );
                    setContext(
                      'p=0.5, epsilon=0.08, n_values=[10,20,40,80,160], trials_per_n=10000, seed=20261025, primary_n=160, tail_side="greater". Use Python standard-library random.Random(seed), exactly n draws per trial. Do not copy reference code. Authorize reasonable implementation choices as explicit assumptions, not missing data. Compare the exact binomial tails against Hoeffding; empirical estimates are finite-sample measurements, not a pass/fail proof. comparable=false, publishedValue=null.',
                    );
                  }}
                >
                  Use theorem-check brief
                </button>
              ) : null}
            </div>
            {voice.error ? <p className="error-text">{voice.error}</p> : null}
            <details className="experiment-options">
              <summary>
                Data, code &amp; execution limits{" "}
                <span>
                  {mode} · {time}s · ${total} cloud cap
                </span>
              </summary>
              <div className="options-grid">
                <label>
                  Agent
                  <select
                    value={agentMode}
                    onChange={(event) =>
                      setAgentMode(
                        event.target.value as ExperimentInput["agentMode"],
                      )
                    }
                  >
                    <option value="pi">Pi · real model</option>
                    <option value="demo">Demo · explicit stubs</option>
                  </select>
                </label>
                <label>
                  Compute
                  <select
                    value={mode}
                    disabled={agentMode === "demo"}
                    onChange={(event) =>
                      setMode(event.target.value as ExperimentInput["mode"])
                    }
                  >
                    <option value="local">Local</option>
                    <option value="vast">Vast.ai</option>
                    <option value="auto">Auto · Jev selection</option>
                  </select>
                </label>
                <label>
                  Execution seconds
                  <input
                    type="number"
                    min={5}
                    max={86400}
                    value={time}
                    onChange={(event) => setTime(Number(event.target.value))}
                    required
                  />
                </label>
                <label>
                  Cloud USD/hour
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={hourly}
                    onChange={(event) => setHourly(Number(event.target.value))}
                  />
                </label>
                <label>
                  Total cloud USD
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={total}
                    onChange={(event) => setTotal(Number(event.target.value))}
                  />
                </label>
                <label>
                  Cloud cleanup
                  <select
                    value={cleanup}
                    onChange={(event) =>
                      setCleanup(
                        event.target.value as ExperimentInput["cleanup"],
                      )
                    }
                  >
                    <option value="destroy">Destroy after export</option>
                    <option value="retain">Retain · billing continues</option>
                  </select>
                </label>
                <label className="option-wide">
                  Author repository
                  <input
                    value={repo}
                    onChange={(event) => setRepo(event.target.value)}
                    placeholder="https://… · optional"
                  />
                </label>
                <label className="option-wide">
                  Data directory
                  <div className="source-row">
                    <input
                      value={data}
                      onChange={(event) => setData(event.target.value)}
                      placeholder="Optional local dataset"
                    />
                    <button type="button" onClick={() => void choose("data")}>
                      Choose
                    </button>
                  </div>
                </label>
              </div>
              <p className="muted">
                Model-provider usage is separate from cloud caps. Local code
                runs as your user, not in an OS sandbox. No execution until you
                review the scientific protocol.
              </p>
            </details>
            {error ? (
              <p className="error-text" role="alert">
                {error}
              </p>
            ) : null}
            <div className="intake-actions">
              <button type="button" onClick={() => setStage("paper")}>
                ← Paper
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={disabled || working || !objective.trim()}
              >
                {working
                  ? "Starting research…"
                  : agentMode === "demo"
                    ? "Prepare demo protocol →"
                    : "Develop reproduction protocol →"}
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
