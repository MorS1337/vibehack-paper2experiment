# Paper2Experiment

Local-first desktop research harness. Add a scientific paper, describe an
experiment in text or voice, connect your own LLM, and get a runnable Python
project executed locally or on a Vast.ai instance, with code, config, logs,
numeric metrics, an independently validated result, and a report.

This is the first working vertical slice: one user, one active experiment, one
coding worker, one Vast instance, and one supported cloud image. It is not a
sandbox and it does not promise that a successful run reproduces a paper.

## Status of verification

This file distinguishes what was actually executed from what is implemented and
configured but not yet exercised. The final integration pass is run by the
maintainer; rows marked **NOT YET VERIFIED** must not be read as confirmed.

| Area | Status |
| --- | --- |
| TypeScript build, unit tests, smoke script | **NOT YET VERIFIED** in this delivery; run the commands below. |
| Electron window and narrow IPC | **NOT YET VERIFIED** in this delivery. |
| Local PDF/arXiv import | **NOT YET VERIFIED** end to end; source extraction code is real and text-only. |
| Real pi model plan/report | **NOT EXERCISED**: no provider credentials were available during development. |
| OpenCode headless worker | **NOT EXERCISED with a model**: server/auth probing is implemented; no provider login was available. |
| LocalBackend real execution and artifacts | **NOT YET VERIFIED** in this delivery; smoke drives the real backend. |
| Bernoulli/Hoeffding demo | **NOT YET RUN** through the app in this delivery. Analytic values are in the demo README; measured values must be recorded after execution. |
| Vast.ai lifecycle | **NOT EXERCISED**: no account, key, or budget. No instance was rented. |
| Jev choice | **NOT EXERCISED**: no `TYPESAFE_API_KEY`. |
| Whisper Russian transcription | **NOT YET VERIFIED**; build/record instructions are below. |
| SmartCompact extension load | **NOT YET VERIFIED**; short sessions may legitimately perform no compaction. |

No paid provisioning occurred during development. Local mode needs no API key
and no Vast account.

## Quick start

Requirements: Node.js **>= 22.19.0**, npm, Python 3.10+ for the demo, and the
platform build tools needed by native dependencies.

```sh
npm ci
npm run build
npm start          # production build in Electron
# or
npm run dev        # build and start
```

Useful checks:

```sh
npm run typecheck
npm test           # behavioral tests (node:test via tsx)
npm run smoke      # real LocalBackend + artifacts + cancel/timeout/history probes
```

`npm run smoke` uses only the local Python reference project. It does not call an
LLM, Jev, Vast, or any paid API, and it removes its temporary directories.

## First-run configuration

The app stores local state under Electron's `userData` directory plus
`research/` (on macOS typically
`~/Library/Application Support/paper2experiment/research`; check the Settings
panel or set `PAPER2_STATE_DIR` to use another directory). Runs are immutable
JSON snapshots plus `events.jsonl`; a run directory contains `source/`, `plans/`,
`project/`, `artifacts/` and `report.md`.

Copy [`settings.example.json`](settings.example.json) to the app's settings
store only if you prefer editing JSON; the Settings panel is the normal path.
It contains no secrets. Secrets are read from the user's existing tool
configuration or environment and never enter the renderer or experiment
project.

| Setting | Meaning |
| --- | --- |
| `piProvider`, `piModel` | pi coordinator provider/model. Auth is pi's own. |
| `openCodeModel` | OpenCode worker model in `provider/model` form. Auth is OpenCode's own. |
| `python` | Python executable used for local virtual environments. |
| `whisperBinary`, `whisperModel` | Local `whisper-cli` and a multilingual GGML model. |
| `sshKeyPath` | Private key used only by the Vast backend. |

### pi authentication (independent from OpenCode)

The repo pins `@earendil-works/pi-coding-agent@1.4.0`. The local CLI is
`./node_modules/.bin/pi`. Authenticate with pi's own flow:

```sh
./node_modules/.bin/pi
/login
/model
```

Credentials are stored by pi (default agent directory `~/.pi/agent/auth.json`,
or `PI_CODING_AGENT_DIR` if set). Alternatively, provider API keys may come
from pi-supported environment variables such as `ANTHROPIC_API_KEY`. Logging in
to pi does **not** authenticate OpenCode, and vice versa. The coordinator uses
the SDK in-process; the CLI is only for auth/settings inspection.

### OpenCode authentication (independent from pi)

The repo pins both `@opencode-ai/sdk@1.19.4` and `opencode-ai@1.19.4`. The
headless server binary is resolved from `node_modules`, not a global install:

```sh
./node_modules/.bin/opencode --version      # must print 1.19.4
./node_modules/.bin/opencode auth login
./node_modules/.bin/opencode auth list
```

Standard OpenCode credentials live at
`~/.local/share/opencode/auth.json` (or environment variables documented by
OpenCode). The harness links that file into its isolated data home at
`~/.paper2experiment/opencode-data/opencode/auth.json`; it does not copy keys
into projects. The model must be `provider/model`, e.g.
`openrouter/anthropic/claude-sonnet-4` or `opencode/<model>` depending on your
provider.

### Jev

Jev (`@typesafe-ai/sdk@0.7.0`) chooses among compute candidates supplied by the
harness; it never provisions an instance. Get a key from the
[TypeSafe console](https://console.typesafe.ai/keys) and export it in the
environment that starts the app:

```sh
export TYPESAFE_API_KEY=...
```

The key is read in the main/harness process only. Without it, Jev reports
`needs_setup`; Local mode still works. Jev is not required for a local run.

### Vast.ai

The Vast integration uses the documented Vast REST API, not the Python SDK.
Create a key on the [Vast keys page](https://cloud.vast.ai/manage-keys/) and
either export `VAST_API_KEY` or use the native file Vast's own CLI writes:

```sh
# one option; keep the file private
mkdir -p ~/.config/vastai
printf '%s\n' "$VAST_API_KEY" > ~/.config/vastai/vast_api_key
chmod 600 ~/.config/vastai/vast_api_key
```

Generate an SSH key and add the **public** key to the Vast account (keys apply
to new instances only):

```sh
ssh-keygen -t ed25519 -C "paper2experiment" -f ~/.ssh/paper2_vast
chmod 600 ~/.ssh/paper2_vast
cat ~/.ssh/paper2_vast.pub
```

Set the private-key path in Settings (`sshKeyPath`). The harness uses a
per-run `known_hosts` with accept-new host keys, not
`StrictHostKeyChecking=no`.

The supported image is
`pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime`. Offers are filtered in ordinary
code by required CPU/RAM/VRAM/disk, verified/rentable status, price, and
storage/network reserves; Jev selects from a small real candidate list. The
selected offer is re-fetched before creation. No instance is created until the
user approves the displayed instance, rate, and time limit.

### Whisper (multilingual, Russian)

Build `whisper.cpp` and download a **multilingual** model (not `.en`):

```sh
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build
cmake --build build -j --config Release
sh ./models/download-ggml-model.sh large-v3-turbo
```

`ggml-large-v3-turbo.bin` is multilingual and accepts Russian. Set
`whisperBinary` to the built `build/bin/whisper-cli` and `whisperModel` to the
absolute path of `models/ggml-large-v3-turbo.bin`.

CLI check with a recording (convert to 16 kHz mono PCM first):

```sh
ffmpeg -i record.m4a -ar 16000 -ac 1 -c:a pcm_s16le /tmp/russian.wav
whisper-cli -m /absolute/path/models/ggml-large-v3-turbo.bin \
  -f /tmp/russian.wav -l ru -nt
```

Suggested Russian test phrase:

> Проверь неравенство Хёффдинга для схемы Бернулли при p = 0.5 и эпсилон = 0.08.

The app records a short message and transcribes it; the text must land in the
editable task field before the user starts the run. Actual Russian transcription
is **not yet verified** in this delivery.

### SmartCompact

`smartcompact@0.1.8` is a dependency and its package declares the pi extension
at `adapters/pi/index.ts`. The harness loads that real extension through pi's
extension mechanism and surfaces its events; it is not a renderer shim. For a
separate pi CLI install:

```sh
./node_modules/.bin/pi install npm:smartcompact
```

SmartCompact compacts only after a finished piece of work when the context
passes its allow line (200k tokens by default), so a short demo session may
show the extension loaded but perform no compaction. That is expected, not a
failure. Compaction reports come from pi's `/smartcompact`/extension events.
Actual loading is **not yet verified** in this delivery.

## Demo case

`demos/bernoulli-hoeffding/` contains a small independent check of Hoeffding's
one-sided inequality for Bernoulli variables. It is deliberately a theorem
check, not a reproduction of a published number.

- Source used by the app: arXiv:1910.02884v1, *Introduction to Concentration
  Inequalities*, section 3.5, PDF pages 8-9. The original 1963 JASA article is
  cited but is a scan without a usable text layer.
- User task: [`demos/bernoulli-hoeffding/task.md`](demos/bernoulli-hoeffding/task.md).
- Frozen plan: [`demos/bernoulli-hoeffding/spec.json`](demos/bernoulli-hoeffding/spec.json).
- Worker contract: [`demos/bernoulli-hoeffding/CONTRACT.md`](demos/bernoulli-hoeffding/CONTRACT.md).
- Scientific notes and provenance: [`demos/bernoulli-hoeffding/README.md`](demos/bernoulli-hoeffding/README.md).
- Reference Python baseline: `demos/bernoulli-hoeffding/reference/` (stdlib only).

To run it in the app:

1. Create an experiment, choose Local mode.
2. Use the arXiv URL `https://arxiv.org/abs/1910.02884` or an absolute path to a
   PDF downloaded with `demos/bernoulli-hoeffding/source/fetch-source.sh`.
3. Paste the task text (or dictate the Russian phrase above).
4. Review the plan: `p=0.5`, `epsilon=0.08`, `n` in {10,20,40,80,160}, 10,000
   trials per `n`, seed `20261025`, primary metric
   `empirical_tail_probability` at `n=160`. Do not mark it comparable to a
   published value.
5. Run. OpenCode must create the project files inside `project/`; validate that
   `samples.csv` has the documented header and that the independent verifier
   recomputes the metric.

The numbers above are the demo defaults. If you revise the plan, the coding
worker must copy the revised `plan.parameters` into `config.json`; the
independent verifier validates those values against the frozen plan rather than
against the defaults (with the domain limits documented in `CONTRACT.md`).

The heuristic the demo checks is

$$
\Pr(\bar X_n - p \ge \varepsilon) \le e^{-2n\varepsilon^2}.
$$

The analytic exact binomial tail at `n=160` is about `0.0238835` and the
Hoeffding bound is about `0.1289926`; these are computed from the declared
parameters, not from a run. A measured empirical value must be taken from the
actual run and must never be replaced by a fixture. An empirical fraction above
the bound is not by itself a violation of the theorem: it is a finite Monte
Carlo estimate with reported standard error.

The reference baseline can be run without the app:

```sh
cd demos/bernoulli-hoeffding/reference
python3 main.py --config config.json
```

It is a transparent baseline and smoke fixture. It is **not** injected as an
OpenCode output; the product flow requires the worker to create files in the
normal `project/` path.

## Vast real-account verification procedure

Do this only with an account you control, a funded balance, and an explicit
budget. No paid instance is created during development or tests.

1. Fund a small Vast balance. Generate an API key; put it in `VAST_API_KEY` or
   `~/.config/vastai/vast_api_key` (`chmod 600`).
2. Add your public SSH key to the Vast account. Confirm
   `ssh -i ~/.ssh/paper2_vast -p <port> root@<host> true` works on a manually
   created instance before blaming the harness.
3. Start the app, open Settings, set `sshKeyPath`, and confirm Vast and SSH show
   a ready/needs-setup reason honestly.
4. Set Local/Vast/Auto, a **positive** hourly budget, a **positive** total
   budget, a short time limit (for example 300 s), and cleanup policy
   `destroy` (default). Auto with no suitable real offer must show "no suitable
   option", not fake a machine.
5. Create the Bernoulli demo or another small project. On Vast/Auto, review the
   approval panel: instance/offer, GPU, hourly rate, total cap, deadline,
   cleanup policy. Note the offer ID. Only then approve.
6. Watch the real events: instance ID persisted immediately, boot/runtime
   deadline, SSH key allowlist, upload excluding `.venv`/secrets/env, remote
   `python -m venv` + requirements, `main.py --config config.json`, logs,
   collection of artifacts, validation, then destroy. Confirm in the Vast
   console that the instance is gone.
7. **Export guard:** if artifact collection or validation fails, the app must
   keep the instance and mark `cleanupRequired`, showing that billing may
   continue. Do not treat exit code 0 as export success. The cleanup action
   retries collection *before* destruction. If the policy is `retain`, the
   instance remains billable by design; destroy it manually.
8. **Cancellation:** cancel during boot and during execution. Agent work and the
   remote process must stop; collection is still attempted for completed
   outputs; cleanup follows policy. A cancellation that cannot safely collect
   or clean up must leave a visible warning, not a silent success.
9. Record the observed offer ID, instance ID, rate, elapsed time, artifacts, and
   cleanup result here or in the release notes. Until that is done, the Vast
   path remains **not exercised**.

Reference docs: [Vast quickstart](https://docs.vast.ai/sdk/python/quickstart),
[Vast SSH keys](https://docs.vast.ai/guides/instances/connect/ssh).

## Architecture

```
src/main/                 Electron main, preload, protocol, narrow IPC
src/renderer/             React UI; no Node, no keys
src/shared/types.ts       immutable contracts: Spec, Run, Artifact, AppAPI...
src/core/source.ts        PDF/arXiv download, text extraction, sourceRefs check
src/core/store.ts         atomic run JSON, JSONL events, settings
src/core/harness.ts       orchestration/status/approval/cancel/recovery
src/core/artifacts.ts     manifest/traversal/symlink checks, hashing, independent verification
src/compute/              LocalBackend and VastBackend (ComputeBackend)
src/integrations/         pi, OpenCode, Jev, Whisper, SmartCompact
demos/                    documented scientific cases and reference baselines
tests/                    behavioral edge cases
scripts/smoke.ts          real local execution probes
```

Key properties:

- `ExperimentSpec` is frozen before execution. Changing scientific conditions
  requires a new plan version. Repairs may change code, not science.
- One active operation and one compute instance. Long work runs in a separate
  process; the Electron UI never blocks.
- Local execution is a separate process group, but **not a security sandbox**:
  generated Python runs with your user's permissions. Only run projects you
  trust; the app warns before executing generated code.
- Artifact collection rejects absolute/traversal paths and symlinks, requires
  manifest-declared outputs plus `metrics.json`, requires all metric values to be
  finite numbers, hashes every artifact, and requires the declared metric name.
- For the demo, the primary metric is recomputed from `samples.csv`; the
  verifier does not read it back from `metrics.json`. The verification string
  states Monte Carlo and comparability limits explicitly.
- Agent children get an allowlisted environment. Vast/Jev/pi credentials are
  stripped before coding/experiment children; provider auth stays in the
  respective tool's own store and never enters the renderer or experiment
  directory.
- After a crash, runs in a busy status become `interrupted`. A saved Vast
  instance remains billable until collected/cleaned. A saved local PID is not
  automatically killed after restart because it may be reused; the UI reports
  it instead of guessing.
- SmartCompact runs as a real pi extension. A short session may not compact.

## Reproducibility and scientific honesty

- A finished process is not a reproduced paper. The UI reports both.
- The demo is a theorem check with an explicit independent implementation,
  `publishedValue: null`, and `comparable: false`.
- The verifier checks schema, bounds, recomputed primary metric, and structural
  determinism preconditions. One artifact set cannot prove that an arbitrary
  PRNG was deterministic; re-running and comparing hashes is stronger.
- For generic experiments, artifact validation confirms required outputs and
  numeric format, not correctness of every metric or equivalence to the paper's
  data, split, and preprocessing.
- External services are reported as configured only when their actual
  auth/health check succeeds. They are not reported as executed unless a real
  run occurred.

## Known limitations

- Text PDFs only; no OCR. Scanned originals (including the 1963 Hoeffding
  article) cannot be imported as-is.
- One supported cloud image, one Vast instance, one coding worker, one user.
- The demo uses known `p`; it does not test unknown-mean or general bounded
  variables.
- Local execution is not sandboxed (see above).
- Vast cost estimates depend on live offers and provider pricing; the harness
  reserves for storage/network where documented but cannot guarantee the final
  invoice. Budgets are hard filters, not billing guarantees.
- `npm audit` findings in transitive dependencies must be evaluated by the
  maintainer; do not downgrade the pinned pi/OpenCode/Electron stack blindly.
- Vast/Jev/pi/OpenCode/Whisper/SmartCompact behavior is only claimed after an
  actual configured run. See the status table.

## Dependencies and licenses

Runtime pins (see `package.json`/`package-lock.json`): Electron 45.0.0, React
19.2.0, TypeScript 5.9.3, `@earendil-works/pi-coding-agent` 1.4.0,
`@opencode-ai/sdk` 1.19.4 and `opencode-ai` 1.19.4, `@typesafe-ai/sdk` 0.7.0,
`smartcompact` 0.1.8, `pdfjs-dist` 5.4.624, `zod` (patched version per the lock),
Node >= 22.19.0.

Our code is MIT licensed; see [`LICENSE`](LICENSE). Paper PDFs, arXiv content,
Whisper models, and third-party services retain their own licenses and terms.
The demo's arXiv PDF is fetched on demand and is not redistributed here.
