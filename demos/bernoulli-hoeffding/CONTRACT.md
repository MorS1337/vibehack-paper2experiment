# Code output contract: `demo = "bernoulli-hoeffding"`

In real Pi mode the agent creates a runnable project in the run's `project/`
directory. In the explicitly labelled stub mode the harness copies `reference/`
and writes the frozen plan parameters into config.json. Neither mode may substitute
metrics: Python actually runs, and the verifier independently recomputes the primary result.

## Project layout

```
project/
  experiment.json
  main.py                 # entry point; must accept --config config.json
  config.json
  requirements.txt
  stdout.log              # created by the compute backend
  stderr.log              # created by the compute backend (may be empty)
  artifacts/
    metrics.json
    samples.csv
```

`experiment.json`:

```json
{
  "entryPoint": "main.py",
  "config": "config.json",
  "requirements": "requirements.txt",
  "artifacts": ["metrics.json", "samples.csv"]
}
```

All manifest paths are relative to `project/`; artifact entries are relative to
`project/artifacts/`. Absolute paths, `..`, and symlinks are rejected.
`requirements.txt` may contain only a comment (stdlib-only is preferred; this
demo needs no third-party packages). The worker may not change scientific
parameters; those are frozen in the plan and must match `config.json`.

## `config.json`

The exact scientific keys below are mandatory. The values shown are the demo
defaults; a revised plan may choose other valid values, but `config.json` must
match that frozen plan's `parameters`. Extra non-scientific keys are ignored by
the verifier.

```json
{
  "p": 0.5,
  "epsilon": 0.08,
  "n_values": [10, 20, 40, 80, 160],
  "trials_per_n": 10000,
  "seed": 20261025,
  "primary_n": 160,
  "tail_side": "greater"
}
```

Constraints enforced independently:

- `0 < p < 1`, `0 < epsilon <= 1`, `p + epsilon <= 1`;
- `n_values` strictly increasing integers in `[1, 100000]`, at least two values;
- `trials_per_n` integer in `[1, 200000]`;
- `seed` integer in `[0, 4294967295]`;
- `primary_n` is one of `n_values` (the default plan uses the largest, 160);
- `tail_side == "greater"`; no other tail convention is supported by this
  verifier, so a revised plan must use `greater` or the run must stop with an
  explicit unsupported-contract error;
- total rows `len(n_values) * trials_per_n <= 2,000,000`;
- every `exp(-2 * n * epsilon^2)` is representable above zero.

## `artifacts/samples.csv`

Exactly this header, no extra columns, no quotes:

```csv
trial,successes,n,p,epsilon
```

- One row per independent repetition, for every `n` in `config.n_values`.
- `trial` is an integer in `1..trials_per_n`, unique within each `n`; all values
  must be present.
- `successes` is an integer in `0..n`.
- `p` and `epsilon` on every row must equal the configured floating-point
  values.
- Rows are generated from the declared `seed` with a documented deterministic
  pseudorandom generator. The verifier enforces unique trials and complete row
  counts, but cannot prove generator determinism from a single run.
- The one-sided tail event is
  `successes >= ceil(n * (p + epsilon) - 1e-12)`.

The reference baseline orders rows by `n` ascending and then `trial` ascending.
Ordering is not required for validation, but deterministic ordering is expected.

## `artifacts/metrics.json`

A flat JSON object; every value must be a finite number. Required keys:

| Key | Meaning |
| --- | --- |
| `empirical_tail_probability` | Primary metric at `primary_n`: tail rows / `trials_per_n`. |
| `hoeffding_bound` | `exp(-2 * primary_n * epsilon^2)`. |
| `exact_binomial_tail_probability` | Exact one-sided binomial tail at the same integer threshold. |
| `bound_minus_empirical` | `hoeffding_bound - empirical_tail_probability`. |
| `bound_minus_exact` | `hoeffding_bound - exact_binomial_tail_probability`. |
| `empirical_to_bound_ratio` | `empirical_tail_probability / hoeffding_bound`. |
| `monte_carlo_standard_error` | `sqrt(theta*(1-theta)/trials_per_n)` for the primary empirical estimate. |
| `max_empirical_minus_bound` | Maximum over configured `n` of empirical tail minus that `n`'s bound. |
| `all_exact_tails_within_bound` | `1` if every exact tail is at most its bound (within floating tolerance), else `0`. |
| `tail_count_primary` | Integer count of tail rows at `primary_n`. |
| `n_primary` | `primary_n`. |
| `p` | Configured `p`. |
| `epsilon` | Configured `epsilon`. |
| `trials_per_n` | Configured trial count. |
| `seed` | Configured seed. |
| `n_configurations` | Number of values in `n_values`. |
| `total_rows` | Data rows in `samples.csv`. |

The verifier recomputes the primary metric and all derived numeric fields from
`samples.csv` and `config.json`. Mismatches fail validation with the key and
both values. Do not round the JSON values aggressively; full double precision is
expected.

## Plots are presentation, not a compute prerequisite

After computation the agent reads actual metrics and per-n values from the
collected outputs and emits an inline fenced `svg` plot in its chat response.
Python produces numbers and samples, not plotting code or a mandatory image.
Label axes, units, scale, series and the numeric source. Do not invent samples or
confuse a theoretical reference curve with measured points. SVG markup is saved
with the conversation and can be downloaded from its figure.

An explicit export request may additionally declare a saved SVG artifact.
Declared files must exist and pass the existing size and executable-content
checks. An SVG export is not required for scientific verification, and visual
geometry is not independently validated as numeric evidence.

## Logs and exit status

`stdout.log` must exist and is collected/hashed. `stderr.log` is optional. The
worker should print a concise JSON/text summary and reserve stderr for errors.
Exit code 0 is necessary but not sufficient: artifact validation must pass.

## What validation does not claim

- It does not prove that an arbitrary PRNG was deterministic; it checks the
  declared seed and structural consistency.
- It does not show that the empirical tail equals the true tail; it reports
  Monte Carlo error and compares against the exact binomial tail.
- It does not reproduce a published numerical result. The plan declares
  `publishedValue: null`, `comparable: false`, and `implementation:
  "independent"`; validation rejects a demo spec that claims otherwise.
- An empirical tail above the Hoeffding bound is not by itself a violation.
