# Ollaya decision models: measured results

Endpoint http://127.0.0.1:11435; 224 answers. Each dataset is split in half (alternating per label); each half picks a threshold that the other half is scored with, and the pooled out-of-fold predictions decide the bar.

## web_query_privacy

Caution class = the outcome that should make Pandesh more careful. Bar: out-of-fold recall ≥ 90% at precision ≥ 80% (threshold tuned on one half, measured on the other, both ways).

| model | wording | AUC | recall@0.5 | FPR@0.5 | thresholds (fold A / B) | out-of-fold recall (95% CI) | out-of-fold precision | bar | ≥0.8 flags / false flags / abstain |
|---|---|---|---|---|---|---|---|---|---|
| decider:0.8b | v3v8.private | 0.99 | 100% | 14% | 0.58 / 0.69 | 93% (77%–98%) | 96% | **yes** | 75% / 0% / 32% |
| decider:2b | v3v8.private | 0.99 | 82% | 0% | 0.18 / 0.29 | 96% (82%–99%) | 93% | **yes** | 68% / 0% / 18% |
| decider:2b | v3.private | 0.99 | 82% | 0% | 0.18 / 0.29 | 96% (82%–99%) | 93% | **yes** | 68% / 0% / 18% |
| decider:0.8b | v3.private | 0.98 | 96% | 14% | 0.58 / 0.69 | 86% (69%–94%) | 96% | no | 61% / 0% / 39% |
| decider:2b | v1.private | 0.98 | 14% | 0% | 0.05 / 0.03 | 89% (73%–96%) | 93% | no | 0% / 0% / 16% |
| kev | v8.private | 0.97 | 25% | 0% | 0.06 / 0.05 | 96% (82%–99%) | 77% | no | 0% / 0% / 30% |
| decider:0.8b | v1.private | 0.97 | 25% | 0% | 0.04 / 0.08 | 93% (77%–98%) | 87% | **yes** | 4% / 0% / 32% |
| decision | v1.private | 0.96 | 50% | 4% | 0.25 / 0.22 | 93% (77%–98%) | 87% | **yes** | 0% / 0% / 55% |
| kev | v2.private | 0.96 | 7% | 0% | 0.24 / 0.24 | 93% (77%–98%) | 84% | **yes** | 0% / 0% / 64% |
| decider:2b | v9.private | 0.95 | 0% | 0% | 0.06 / 0.02 | 71% (53%–85%) | 83% | no | 0% / 0% / 4% |
| decider:2b | v2.private | 0.95 | 0% | 0% | 0.03 / 0.04 | 86% (69%–94%) | 89% | no | 0% / 0% / 4% |
| decider:0.8b | v9.private | 0.94 | 0% | 0% | 0.03 / 0.02 | 75% (57%–87%) | 84% | no | 0% / 0% / 2% |
| decision | v3v8.private | 0.94 | 93% | 18% | 0.47 / 0.67 | 86% (69%–94%) | 83% | no | 64% / 7% / 34% |
| decision | v3.private | 0.94 | 93% | 18% | 0.47 / 0.58 | 93% (77%–98%) | 84% | **yes** | 61% / 7% / 34% |
| decision | v8.private | 0.93 | 46% | 0% | 0.25 / 0.10 | 79% (60%–90%) | 85% | no | 4% / 0% / 39% |
| kev | v9.private | 0.93 | 7% | 0% | 0.20 / 0.15 | 89% (73%–96%) | 81% | no | 0% / 0% / 45% |
| decider:2b | v8.private | 0.93 | 0% | 0% | 0.00 / 0.01 | 86% (69%–94%) | 86% | no | 0% / 0% / 16% |
| decision | v2.private | 0.93 | 4% | 0% | 0.15 / 0.12 | 79% (60%–90%) | 88% | no | 0% / 0% / 23% |
| kev | v1.private | 0.92 | 29% | 0% | 0.14 / 0.19 | 86% (69%–94%) | 77% | no | 0% / 0% / 50% |
| decision | v9.private | 0.92 | 18% | 4% | 0.17 / 0.13 | 89% (73%–96%) | 83% | no | 0% / 0% / 43% |
| kev | v3v8.private | 0.91 | 89% | 25% | 0.50 / 0.64 | 82% (64%–92%) | 79% | no | 39% / 0% / 70% |
| kev | v3.private | 0.91 | 89% | 25% | 0.50 / 0.64 | 82% (64%–92%) | 79% | no | 39% / 0% / 70% |
| decider:0.8b | v8.private | 0.88 | 57% | 0% | 0.08 / 0.03 | 64% (46%–79%) | 86% | no | 36% / 0% / 13% |
| decider:0.8b | v2.private | 0.84 | 0% | 0% | 0.06 / 0.05 | 71% (53%–85%) | 91% | no | 0% / 0% / 4% |

## Latency per call (all questions of a decision in one call, CPU)

| model | decision | calls | errors | p50 ms | p95 ms | served by |
|---|---|---|---|---|---|---|
| decider:0.8b | web_query_privacy | 56 | 0 | 2028 | 2133 | decider:0.8b |
| decider:2b | web_query_privacy | 56 | 0 | 4280 | 4558 | decider:2b |
| decision | web_query_privacy | 56 | 0 | 2953 | 3083 | decision:latest |
| kev | web_query_privacy | 56 | 0 | 2220 | 2366 | kev:latest |
