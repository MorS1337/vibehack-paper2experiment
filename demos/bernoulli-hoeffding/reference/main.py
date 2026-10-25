#!/usr/bin/env python3
"""Reference baseline for the Bernoulli/Hoeffding demo.

This is an independent implementation of Hoeffding's one-sided bound for
independent Bernoulli(p) observations. It is used to smoke-test the harness and
as a transparent scientific baseline for the expected artifacts. It is NOT
evidence that pi generated the implementation.

Python 3.10+ standard library only. Determinism is explicit: random words come
from SplitMix64 seeded with config.seed; no platform RNG is involved.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

MASK64 = (1 << 64) - 1
GOLDEN = 0x9E3779B97F4A7C15
MIX1 = 0xBF58476D1CE4E5B9
MIX2 = 0x94D049BB133111EB
TWO53 = 1 << 53


class SplitMix64:
    def __init__(self, seed: int) -> None:
        self.state = seed & MASK64

    def next_u64(self) -> int:
        self.state = (self.state + GOLDEN) & MASK64
        z = self.state
        z = ((z ^ (z >> 30)) * MIX1) & MASK64
        z = ((z ^ (z >> 27)) * MIX2) & MASK64
        return (z ^ (z >> 31)) & MASK64

    def uniform_53(self) -> float:
        """Uniform float in [0, 1) with exactly 53 random bits."""
        return (self.next_u64() >> 11) * (1.0 / TWO53)

    def bernoulli(self, p: float) -> bool:
        return self.uniform_53() < p


def require_int(config: dict, key: str, low: int, high: int) -> int:
    value = config.get(key)
    if type(value) is not int or not (low <= value <= high):
        raise ValueError(f"config.{key} must be an integer in [{low}, {high}]")
    return value


def require_number(config: dict, key: str) -> float:
    value = config.get(key)
    if type(value) not in (int, float) or not math.isfinite(float(value)):
        raise ValueError(f"config.{key} must be a finite number")
    return float(value)


def load_config(path: Path) -> dict:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("config must be a JSON object")
    required = {"p", "epsilon", "n_values", "trials_per_n", "seed", "primary_n", "tail_side"}
    missing = required.difference(raw)
    if missing:
        raise ValueError("config is missing scientific parameters: " + ", ".join(sorted(missing)))

    p = require_number(raw, "p")
    epsilon = require_number(raw, "epsilon")
    if not 0.0 < p < 1.0:
        raise ValueError("config.p must be in (0, 1)")
    if not 0.0 < epsilon <= 1.0:
        raise ValueError("config.epsilon must be in (0, 1]")
    if p + epsilon > 1.0 + 1e-12:
        raise ValueError("config.p + config.epsilon must not exceed 1 for a one-sided upper tail")

    raw_n = raw.get("n_values")
    if not isinstance(raw_n, list) or not 2 <= len(raw_n) <= 32:
        raise ValueError("config.n_values must contain between two and 32 sample sizes")
    n_values: list[int] = []
    for index, value in enumerate(raw_n):
        if type(value) is not int or not 1 <= value <= 100_000:
            raise ValueError(f"config.n_values[{index}] must be an integer in [1, 100000]")
        n_values.append(value)
    if any(right <= left for left, right in zip(n_values, n_values[1:])):
        raise ValueError("config.n_values must be strictly increasing")
    if len(set(n_values)) != len(n_values):
        raise ValueError("config.n_values must not contain duplicates")

    trials_per_n = require_int(raw, "trials_per_n", 1, 200_000)
    seed = require_int(raw, "seed", 0, 0xFFFFFFFF)
    primary_n = require_int(raw, "primary_n", 1, 100_000)
    if primary_n not in n_values:
        raise ValueError("config.primary_n must be one of config.n_values")
    if raw.get("tail_side") != "greater":
        raise ValueError("config.tail_side must be 'greater'")
    if len(n_values) * trials_per_n > 2_000_000:
        raise ValueError("config would produce more than 2,000,000 sample rows")
    for n in n_values:
        if not math.exp(-2.0 * n * epsilon * epsilon) > 0.0:
            raise ValueError(f"the Hoeffding bound underflows at n={n}")

    return {
        "p": p,
        "epsilon": epsilon,
        "n_values": n_values,
        "trials_per_n": trials_per_n,
        "seed": seed,
        "primary_n": primary_n,
        "tail_side": "greater",
    }


def tail_threshold(n: int, p: float, epsilon: float) -> int:
    # Integer threshold avoids platform-dependent rounding at successes/n - p == epsilon.
    return min(n + 1, max(0, math.ceil(n * (p + epsilon) - 1e-12)))


def log_factorials(max_n: int) -> list[float]:
    table = [0.0] * (max_n + 1)
    for n in range(1, max_n + 1):
        table[n] = table[n - 1] + math.log(n)
    return table


def binomial_upper_tail(n: int, p: float, threshold: int, log_facts: list[float]) -> float:
    if threshold <= 0:
        return 1.0
    if threshold > n:
        return 0.0
    if p <= 0.0 or p >= 1.0:
        return 0.0
    log_p = math.log(p)
    log_q = math.log1p(-p)
    total = 0.0
    compensation = 0.0
    for k in range(threshold, n + 1):
        log_term = log_facts[n] - log_facts[k] - log_facts[n - k] + k * log_p + (n - k) * log_q
        term = math.exp(log_term)
        adjusted = term - compensation
        updated = total + adjusted
        compensation = (updated - total) - adjusted
        total = updated
    return min(1.0, max(0.0, total))




def main() -> int:
    parser = argparse.ArgumentParser(description="Bernoulli/Hoeffding reference baseline")
    parser.add_argument("--config", required=True, help="path to config.json")
    args = parser.parse_args()

    project_dir = Path(__file__).resolve().parent
    config_path = Path(args.config)
    if not config_path.is_absolute():
        config_path = (Path.cwd() / config_path).resolve()
    config = load_config(config_path)

    artifacts_dir = project_dir / "artifacts"
    if artifacts_dir.is_symlink():
        raise SystemExit("artifacts directory must not be a symlink")
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    p = config["p"]
    epsilon = config["epsilon"]
    trials = config["trials_per_n"]
    rng = SplitMix64(config["seed"])
    thresholds = {n: tail_threshold(n, p, epsilon) for n in config["n_values"]}
    tail_counts = {n: 0 for n in config["n_values"]}

    samples_path = artifacts_dir / "samples.csv"
    with samples_path.open("w", encoding="utf-8", newline="") as handle:
        handle.write("trial,successes,n,p,epsilon\n")
        for n in config["n_values"]:
            for trial in range(1, trials + 1):
                successes = sum(1 for _ in range(n) if rng.bernoulli(p))
                if successes >= thresholds[n]:
                    tail_counts[n] += 1
                handle.write(f"{trial},{successes},{n},{p!r},{epsilon!r}\n")

    max_n = max(config["n_values"])
    log_facts = log_factorials(max_n)
    empirical = [tail_counts[n] / trials for n in config["n_values"]]
    bounds = [math.exp(-2.0 * n * epsilon * epsilon) for n in config["n_values"]]
    exact = [
        binomial_upper_tail(n, p, thresholds[n], log_facts)
        for n in config["n_values"]
    ]
    primary_index = config["n_values"].index(config["primary_n"])
    primary_tail = empirical[primary_index]
    primary_bound = bounds[primary_index]
    primary_exact = exact[primary_index]
    standard_error = math.sqrt(max(0.0, primary_tail * (1.0 - primary_tail) / trials))
    max_excess = max(tail - bound for tail, bound in zip(empirical, bounds))
    all_exact_within_bound = int(all(
        value <= bound + 1e-12 * max(1.0, bound)
        for value, bound in zip(exact, bounds)
    ))

    metrics = {
        "empirical_tail_probability": primary_tail,
        "hoeffding_bound": primary_bound,
        "exact_binomial_tail_probability": primary_exact,
        "bound_minus_empirical": primary_bound - primary_tail,
        "bound_minus_exact": primary_bound - primary_exact,
        "empirical_to_bound_ratio": primary_tail / primary_bound,
        "monte_carlo_standard_error": standard_error,
        "max_empirical_minus_bound": max_excess,
        "all_exact_tails_within_bound": all_exact_within_bound,
        "tail_count_primary": tail_counts[config["primary_n"]],
        "n_primary": config["primary_n"],
        "p": p,
        "epsilon": epsilon,
        "trials_per_n": trials,
        "seed": config["seed"],
        "n_configurations": len(config["n_values"]),
        "total_rows": len(config["n_values"]) * trials,
    }
    (artifacts_dir / "metrics.json").write_text(
        json.dumps(metrics, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    summary = {
        "demo": "bernoulli-hoeffding",
        "config": config,
        "per_n": [
            {
                "n": n,
                "empirical_tail_probability": empirical[index],
                "hoeffding_bound": bounds[index],
                "exact_binomial_tail_probability": exact[index],
            }
            for index, n in enumerate(config["n_values"])
        ],
        "metrics": metrics,
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    print(f"wrote {samples_path} ({metrics['total_rows']} rows)")
    print(f"wrote {artifacts_dir / 'metrics.json'}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2)
