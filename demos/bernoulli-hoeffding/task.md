Create a small, reproducible Python 3 experiment that checks Hoeffding's one-sided inequality for independent Bernoulli random variables.

Use p = 0.5, epsilon = 0.08, n in {10, 20, 40, 80, 160}, 10,000 independent trials for each n, and seed 20261025. For each trial draw exactly n Bernoulli(p) values with a seeded deterministic pseudorandom generator and record the number of successes. The tail event is one-sided: successes/n - p >= epsilon, using the integer threshold ceil(n*(p + epsilon) - 1e-12).

Write artifacts/samples.csv with exactly this header and no extra columns:

trial,successes,n,p,epsilon

One row per repetition; trial is 1..10000 within each n; all five n values must appear. Write artifacts/metrics.json as a JSON object whose values are all finite numbers. The primary metric is empirical_tail_probability at n = 160. Also include hoeffding_bound = exp(-2*n*epsilon^2), exact_binomial_tail_probability at the same threshold, bound_minus_empirical, bound_minus_exact, empirical_to_bound_ratio, monte_carlo_standard_error = sqrt(theta*(1-theta)/10000) where theta is the primary empirical tail probability, max_empirical_minus_bound across all n, all_exact_tails_within_bound (0 or 1), tail_count_primary, n_primary, p, epsilon, trials_per_n, seed, n_configurations, and total_rows. Write artifacts/plot.svg showing the empirical tail, Hoeffding bound, and exact binomial tail as functions of n; give the series readable labels.

The project must contain experiment.json with entryPoint main.py, config config.json, requirements requirements.txt, and artifacts [metrics.json, samples.csv, plot.svg]. main.py must accept --config config.json and be runnable from the project directory. Keep the config scientific parameters identical to this task; do not silently change p, epsilon, n, seed, or trial count. The requirements file may declare no third-party packages. Do not use the network and do not use any API credentials.

Important: this is an independent implementation of the theorem. Do not claim to reproduce a published numerical result. Print a concise summary to stdout and leave stderr for real errors.
