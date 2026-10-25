# Bernoulli check of Hoeffding's inequality

This is a small, fully specified scientific demo for Paper2Experiment. It tests a
theorem, not a reported experimental number, so the harness can honestly separate
"the process finished" from "the paper's result was reproduced".

> **Verification status:** the analytic bound/exact-tail numbers below were
> computed from the declared parameters. The reference baseline and the app path
> through OpenCode/LocalBackend are run by the parent integration pass; the
> numbers measured by that pass are not yet recorded here. Do not replace them
> with fixture values.

## Scientific claim

For independent random variables $X_1,\dots,X_n \in [0,1]$ with
$\bar X_n = (X_1+\dots+X_n)/n$ and $\mu = \mathbb E[\bar X_n]$,

$$
\Pr\!\left(\bar X_n - \mu \ge \varepsilon\right) \le e^{-2n\varepsilon^2}.
$$

For $X_i \sim \mathrm{Bernoulli}(p)$ and known $p$, $\mu=p$. The demo simulates
the one-sided event $\bar X_n - p \ge \varepsilon$ at several sample sizes and
compares three quantities:

1. the empirical tail probability from simulated samples;
2. Hoeffding's bound $e^{-2n\varepsilon^2}$;
3. the exact one-sided binomial tail at the same threshold.

The exact binomial tail is included because an empirical Monte Carlo estimate
alone cannot tell whether the bound is conservative or whether the simulator is
wrong. The bound applies to the true tail probability; an empirical fraction
above the bound is not by itself a violation, because the fraction has sampling
error.

## Source provenance

- **Primary reference:** Wassily Hoeffding, "Probability Inequalities for Sums of
  Bounded Random Variables", *Journal of the American Statistical Association*
  58(301), 1963, pp. 13-30. DOI:
  [10.1080/01621459.1963.10500830](https://doi.org/10.1080/01621459.1963.10500830).
- **PDF used by the app:** Kumar Abhishek, Sneha Maheshwari, Sujit Gujar,
  "Introduction to Concentration Inequalities", arXiv:1910.02884v1 (2019),
  <https://arxiv.org/abs/1910.02884v1>. Section 3.5, PDF pages 8-9, restates
  Hoeffding's inequality and its two-sided variant.
- The PDF is **not vendored** in this repository. Run
  `source/fetch-source.sh` to download the exact verified version, or import the
  arXiv URL directly in the app. `source/source.json` records the expected
  SHA-256 and retrieval metadata.
- The 1963 JASA original is a scan without a usable text layer. It was verified
  as the origin of the theorem but is not used as the app's importable source;
  the arXiv report is the text-extractable secondary statement.

The source quotes in `spec.json` were checked against the extracted text of
PDF page 8 and page 9. They are not invented citations.

## Experimental design

Parameters are fixed in `spec.json` and `reference/config.json`:

| Parameter | Value |
| --- | --- |
| $p$ | 0.5 |
| $\varepsilon$ | 0.08 |
| $n$ | 10, 20, 40, 80, 160 |
| trials per $n$ | 10,000 |
| primary $n$ | 160 |
| seed | 20261025 |
| tail side | one-sided, `greater` |
| tail threshold | $\lceil n(p+\varepsilon) - 10^{-12}\rceil$ |

For every $n$, 10,000 independent samples of exactly $n$ Bernoulli draws are
generated. Each row of `samples.csv` is one repetition and contains only the
trial index, success count, $n$, $p$ and $\varepsilon$. The primary metric is
the tail frequency at $n=160$; the exact binomial tail and Hoeffding bound are
computed from the declared parameters, not read back from the simulation.

At these settings Hoeffding's bound is visibly conservative: the exact tail at
$n=160$ is about 0.0239 versus a bound of about 0.1290. That gap is the point of
the demo. It also means the empirical tail is a low-probability event, so the
Monte Carlo standard error is reported and the comparison is not presented as a
tightness claim.

## Independent implementation

The reference simulator in `reference/` is a transparent baseline for smoke
tests and manual reproduction. It is intentionally not the OpenCode worker
result. The product flow must ask the coding worker to create its own project in
the run's `project/` directory, and its output must satisfy `CONTRACT.md`.
The harness's independent verifier recomputes the primary metric from the
worker's `samples.csv`; it never trusts `metrics.json` for that value.

No author code exists for this check. `implementation: "independent"` and
`publishedValue: null` are deliberate. The demo does **not** claim to reproduce
a published numerical result.

## Run the reference baseline

Requires Python 3.10+ (standard library only):

```sh
cd demos/bernoulli-hoeffding/reference
python3 main.py --config config.json
```

Outputs:

```
artifacts/samples.csv
artifacts/metrics.json
artifacts/plot.svg
```

The command prints the per-$n$ comparison and the same numeric object written to
`metrics.json`. The baseline is deterministic for the documented SplitMix64
stream in `reference/main.py`; a worker may use another documented seeded PRNG
as long as `samples.csv` satisfies the contract.

## What the verifier checks

For this demo `collectAndValidate` performs an independent recomputation:

- parses every row, enforces the exact CSV header, integer counts, ranges,
  unique `(n, trial)` pairs, exactly 10,000 rows per declared $n$, and matching
  $p$, $\varepsilon$, seed and sizes;
- recomputes the empirical tail from success counts (not from `metrics.json`);
- recomputes the Hoeffding bound and exact binomial tail and checks that the
  exact tail does not exceed the bound;
- checks the reported metrics against its own values;
- validates that the SVG contains both series and actual data marks;
- hashes every artifact and reports comparability limits explicitly.

It cannot prove from one artifact set that an arbitrary generator was
deterministic; it checks the seed declaration and the structural determinism
preconditions. Re-running and comparing hashes is a stronger check for the
reference baseline.

## Limitations

- The source is an expository arXiv report; the theorem is Hoeffding's, but the
  report is not the original paper. This is stated in the plan and report.
- Bernoulli sampling with known $p$ is a deliberately narrow, exactly checkable
  instance of the inequality. It does not test Hoeffding's inequality for
  general bounded variables or estimated means.
- The finite simulation estimates a tail; it does not prove the inequality.
- The exact binomial computation uses floating-point logarithms; agreement with
  the harness is checked to a tolerance, not to symbolic exactness.
- No claim is made that the simulation reproduces any number in the cited paper
  or the original article.

## Files

```
spec.json                    ExperimentSpec for the plan (schema-validated by the app)
task.md                      paste-ready user task text
CONTRACT.md                  exact worker output contract
source/source.json           provenance, expected PDF SHA-256, licensing note
source/fetch-source.sh       verified download of the arXiv PDF
reference/main.py            independent reference baseline (stdlib only)
reference/experiment.json    manifest for the reference project
reference/config.json        exact scientific configuration
reference/requirements.txt   no third-party packages
```
