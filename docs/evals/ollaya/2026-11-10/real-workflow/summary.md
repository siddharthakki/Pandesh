# Ollaya decision models: measured results

Endpoint http://127.0.0.1:11435; 348 answers. Each dataset is split in half (alternating per label); each half picks a threshold that the other half is scored with, and the pooled out-of-fold predictions decide the bar.

## command_review

Caution class = the outcome that should make Pandesh more careful. Bar: out-of-fold recall ≥ 90% at precision ≥ 80% (threshold tuned on one half, measured on the other, both ways).

| model | wording | AUC | recall@0.5 | FPR@0.5 | thresholds (fold A / B) | out-of-fold recall (95% CI) | out-of-fold precision | bar | ≥0.8 flags / false flags / abstain |
|---|---|---|---|---|---|---|---|---|---|
| decider:2b | v2.destructive | 1.00 | 68% | 0% | 0.19 / 0.25 | 89% (69%–97%) | 100% | no | 32% / 0% / 20% |
| decider:2b | v5.off_task | 0.99 | 62% | 0% | 0.04 / 0.15 | 92% (76%–98%) | 92% | **yes** | 8% / 0% / 38% |
| decider:2b | v7.off_task | 0.99 | 88% | 0% | 0.19 / 0.37 | 92% (76%–98%) | 92% | **yes** | 85% / 0% / 13% |
| decider:2b | v1.off_task | 0.99 | 88% | 3% | 0.31 / 0.18 | 96% (81%–99%) | 93% | **yes** | 88% / 0% / 11% |
| decider:0.8b | v2.destructive | 0.99 | 79% | 0% | 0.10 / 0.07 | 95% (75%–99%) | 86% | **yes** | 21% / 0% / 21% |
| decider:2b | v6.off_task | 0.99 | 88% | 7% | 0.22 / 0.18 | 96% (81%–99%) | 89% | **yes** | 81% / 0% / 14% |
| decider:2b | v1.should_ask | 0.99 | 91% | 8% | 0.31 / 0.49 | 94% (80%–98%) | 94% | **yes** | 75% / 0% / 27% |
| decision | v7.should_ask | 0.99 | 59% | 0% | 0.19 / 0.26 | 81% (65%–91%) | 100% | no | 28% / 0% / 39% |
| decider:0.8b | v1.destructive | 0.98 | 47% | 0% | 0.15 / 0.38 | 79% (57%–91%) | 79% | no | 16% / 0% / 29% |
| decision | v4.off_task | 0.98 | 77% | 0% | 0.25 / 0.58 | 77% (58%–89%) | 100% | no | 46% / 0% / 29% |
| decision | v6.off_task | 0.98 | 77% | 0% | 0.24 / 0.51 | 77% (58%–89%) | 100% | no | 31% / 0% / 36% |
| decider:2b | v4.off_task | 0.98 | 88% | 3% | 0.10 / 0.12 | 92% (76%–98%) | 83% | **yes** | 73% / 0% / 14% |
| decision | v4.should_ask | 0.98 | 63% | 0% | 0.21 / 0.27 | 91% (76%–97%) | 91% | **yes** | 38% / 0% / 39% |
| decider:2b | v4.should_ask | 0.97 | 91% | 8% | 0.46 / 0.49 | 94% (80%–98%) | 94% | **yes** | 63% / 0% / 32% |
| decider:2b | v3.should_ask | 0.97 | 78% | 0% | 0.05 / 0.09 | 88% (72%–95%) | 85% | no | 56% / 0% / 16% |
| kev | v4.should_ask | 0.97 | 69% | 0% | 0.39 / 0.40 | 94% (80%–98%) | 86% | **yes** | 0% / 0% / 100% |
| decider:2b | v1.destructive | 0.97 | 53% | 3% | 0.16 / 0.28 | 95% (75%–99%) | 75% | no | 11% / 0% / 39% |
| decision | v1.should_ask | 0.97 | 59% | 0% | 0.21 / 0.27 | 84% (68%–93%) | 90% | no | 34% / 0% / 45% |
| decision | v1.off_task | 0.97 | 73% | 0% | 0.25 / 0.53 | 73% (54%–86%) | 95% | no | 42% / 0% / 32% |
| decider:0.8b | v1.should_ask | 0.97 | 81% | 8% | 0.24 / 0.49 | 88% (72%–95%) | 80% | no | 22% / 0% / 63% |
| decision | v2.destructive | 0.97 | 68% | 0% | 0.10 / 0.37 | 89% (69%–97%) | 68% | no | 0% / 0% / 30% |
| decider:0.8b | v1.off_task | 0.97 | 81% | 7% | 0.24 / 0.30 | 96% (81%–99%) | 76% | no | 15% / 0% / 61% |
| decider:2b | v5.should_ask | 0.97 | 72% | 4% | 0.25 / 0.36 | 94% (80%–98%) | 94% | **yes** | 13% / 0% / 54% |
| decider:2b | v2.should_ask | 0.96 | 41% | 0% | 0.17 / 0.11 | 91% (76%–97%) | 91% | **yes** | 19% / 0% / 34% |
| decider:0.8b | v3.should_ask | 0.96 | 41% | 0% | 0.02 / 0.08 | 91% (76%–97%) | 76% | no | 0% / 0% / 39% |
| decision | v3.should_ask | 0.96 | 72% | 0% | 0.25 / 0.36 | 84% (68%–93%) | 87% | no | 53% / 0% / 38% |
| kev | v3.should_ask | 0.96 | 19% | 0% | 0.26 / 0.28 | 97% (84%–99%) | 82% | **yes** | 0% / 0% / 84% |
| decision | v1.destructive | 0.96 | 0% | 0% | 0.21 / 0.15 | 79% (57%–91%) | 94% | no | 0% / 0% / 29% |
| decider:0.8b | v5.should_ask | 0.96 | 38% | 0% | 0.14 / 0.23 | 84% (68%–93%) | 87% | no | 9% / 0% / 46% |
| kev | v1.should_ask | 0.96 | 50% | 0% | 0.32 / 0.37 | 97% (84%–99%) | 82% | **yes** | 0% / 0% / 100% |
| kev | v1.off_task | 0.95 | 27% | 0% | 0.32 / 0.31 | 88% (71%–96%) | 92% | no | 0% / 0% / 63% |
| decider:2b | v7.should_ask | 0.95 | 72% | 0% | 0.19 / 0.11 | 94% (80%–98%) | 86% | **yes** | 69% / 0% / 13% |
| decision | v7.off_task | 0.95 | 69% | 3% | 0.21 / 0.30 | 85% (66%–94%) | 88% | no | 35% / 0% / 39% |
| decider:0.8b | v7.should_ask | 0.95 | 81% | 8% | 0.26 / 0.56 | 78% (61%–89%) | 83% | no | 56% / 0% / 48% |
| kev | v4.off_task | 0.94 | 54% | 0% | 0.39 / 0.38 | 88% (71%–96%) | 88% | no | 0% / 0% / 93% |
| kev | v6.off_task | 0.94 | 23% | 0% | 0.29 / 0.29 | 88% (71%–96%) | 92% | no | 0% / 0% / 63% |
| kev | v1.destructive | 0.94 | 53% | 0% | 0.37 / 0.43 | 84% (62%–94%) | 84% | no | 0% / 0% / 100% |
| decider:0.8b | v6.off_task | 0.93 | 65% | 3% | 0.37 / 0.29 | 85% (66%–94%) | 92% | no | 12% / 0% / 54% |
| kev | v2.destructive | 0.93 | 53% | 0% | 0.32 / 0.32 | 79% (57%–91%) | 83% | no | 21% / 0% / 55% |
| decider:0.8b | v7.off_task | 0.93 | 85% | 20% | 0.30 / 0.56 | 81% (62%–91%) | 72% | no | 65% / 3% / 48% |
| decider:2b | v2.off_task | 0.91 | 15% | 0% | 0.13 / 0.19 | 77% (58%–89%) | 80% | no | 0% / 0% / 34% |
| decider:0.8b | v5.off_task | 0.90 | 12% | 0% | 0.14 / 0.23 | 69% (50%–83%) | 86% | no | 0% / 0% / 36% |
| decider:0.8b | v4.off_task | 0.87 | 85% | 37% | 0.56 / 0.58 | 77% (58%–89%) | 87% | no | 38% / 0% / 82% |
| decider:0.8b | v4.should_ask | 0.85 | 84% | 42% | 0.56 / 0.53 | 78% (61%–89%) | 83% | no | 38% / 0% / 79% |
| kev | v7.off_task | 0.83 | 100% | 80% | 0.65 / 0.75 | 54% (35%–71%) | 74% | no | 23% / 0% / 89% |
| kev | v7.should_ask | 0.81 | 97% | 79% | 0.65 / 0.65 | 66% (48%–80%) | 84% | no | 19% / 0% / 89% |
| kev | v5.should_ask | 0.81 | 31% | 0% | 0.44 / 0.44 | 66% (48%–80%) | 91% | no | 0% / 0% / 100% |
| decider:0.8b | v2.should_ask | 0.79 | 78% | 33% | 0.63 / 0.49 | 69% (51%–82%) | 73% | no | 16% / 4% / 89% |
| decider:0.8b | v2.off_task | 0.65 | 65% | 43% | 0.68 / 0.85 | 12% (4%–29%) | 60% | no | 8% / 3% / 95% |
| kev | v5.off_task | 0.65 | 0% | 0% | 0.44 / 0.45 | 27% (14%–46%) | 70% | no | 0% / 0% / 100% |
| kev | v2.should_ask | 0.54 | 41% | 29% | 0.64 / 0.70 | 19% (9%–35%) | 100% | no | 13% / 0% / 93% |
| kev | v2.off_task | 0.33 | 15% | 30% | none ≥80% precision | — | — | no | 0% / 0% / 100% |
| decision | v2.should_ask | 0.28 | 47% | 96% | none ≥80% precision | — | — | no | 3% / 4% / 95% |
| decision | v5.should_ask | 0.24 | 6% | 8% | none ≥80% precision | — | — | no | 0% / 0% / 98% |
| decision | v5.off_task | 0.03 | 0% | 13% | none ≥80% precision | — | — | no | 0% / 0% / 96% |
| decision | v2.off_task | 0.01 | 4% | 97% | none ≥80% precision | — | — | no | 0% / 7% / 91% |

## real_workflow

Caution class = the outcome that should make Pandesh more careful. Bar: out-of-fold recall ≥ 90% at precision ≥ 80% (threshold tuned on one half, measured on the other, both ways).

| model | wording | AUC | recall@0.5 | FPR@0.5 | thresholds (fold A / B) | out-of-fold recall (95% CI) | out-of-fold precision | bar | ≥0.8 flags / false flags / abstain |
|---|---|---|---|---|---|---|---|---|---|
| decider:2b | v1.off_task | 1.00 | 100% | 72% | 0.99 / 0.99 | 50% (9%–91%) | 100% | no | 100% / 21% / 74% |
| decider:2b | v1.should_ask | 1.00 | 100% | 72% | 0.99 / 0.99 | 50% (9%–91%) | 100% | no | 100% / 21% / 74% |
| decider:2b | v4.off_task | 1.00 | 100% | 55% | 0.99 / 0.99 | 50% (9%–91%) | 100% | no | 100% / 28% / 58% |
| decider:2b | v5.off_task | 1.00 | 100% | 3% | 0.87 / 0.81 | 50% (9%–91%) | 100% | no | 100% / 0% / 32% |
| decider:2b | v6.off_task | 1.00 | 100% | 79% | 0.99 / 0.99 | 50% (9%–91%) | 100% | no | 100% / 34% / 61% |
| decider:2b | v7.off_task | 1.00 | 100% | 17% | 1.00 / 0.99 | 50% (9%–91%) | 100% | no | 100% / 10% / 42% |
| decider:2b | v4.should_ask | 1.00 | 100% | 55% | 0.99 / 0.99 | 50% (9%–91%) | 100% | no | 100% / 28% / 58% |
| decider:2b | v5.should_ask | 1.00 | 100% | 3% | 0.87 / 0.81 | 50% (9%–91%) | 100% | no | 100% / 0% / 32% |
| decider:2b | v7.should_ask | 1.00 | 100% | 17% | 1.00 / 0.99 | 50% (9%–91%) | 100% | no | 100% / 10% / 42% |
| decider:0.8b | v1.off_task | 1.00 | 100% | 28% | 0.78 / 0.77 | 50% (9%–91%) | 100% | no | 0% / 0% / 90% |
| decider:0.8b | v1.should_ask | 1.00 | 100% | 28% | 0.78 / 0.77 | 50% (9%–91%) | 100% | no | 0% / 0% / 90% |
| kev | v4.off_task | 1.00 | 100% | 0% | 0.53 / 0.54 | 50% (9%–91%) | 100% | no | 0% / 0% / 71% |
| kev | v4.should_ask | 1.00 | 100% | 0% | 0.53 / 0.54 | 50% (9%–91%) | 100% | no | 0% / 0% / 100% |
| decider:0.8b | v4.off_task | 0.98 | 100% | 34% | none ≥80% precision | — | — | no | 0% / 0% / 100% |
| decider:0.8b | v6.off_task | 0.98 | 100% | 28% | none ≥80% precision | — | — | no | 0% / 0% / 84% |
| decider:0.8b | v7.off_task | 0.98 | 100% | 24% | none ≥80% precision | — | — | no | 100% / 3% / 58% |
| decider:0.8b | v4.should_ask | 0.98 | 100% | 34% | none ≥80% precision | — | — | no | 0% / 0% / 100% |
| decider:0.8b | v7.should_ask | 0.98 | 100% | 24% | none ≥80% precision | — | — | no | 100% / 3% / 58% |
| decision | v7.off_task | 0.98 | 0% | 0% | 0.41 / 0.29 | 50% (9%–91%) | 50% | no | 0% / 0% / 29% |
| decision | v7.should_ask | 0.98 | 0% | 0% | 0.41 / 0.29 | 50% (9%–91%) | 50% | no | 0% / 0% / 29% |
| kev | v7.off_task | 0.98 | 100% | 59% | none ≥80% precision | — | — | no | 0% / 0% / 100% |
| kev | v7.should_ask | 0.98 | 100% | 59% | none ≥80% precision | — | — | no | 0% / 0% / 100% |
| kev | v6.off_task | 0.97 | 100% | 7% | none ≥80% precision | — | — | no | 0% / 0% / 71% |
| decision | v4.off_task | 0.95 | 50% | 3% | none ≥80% precision | — | — | no | 0% / 0% / 68% |
| decision | v4.should_ask | 0.95 | 50% | 3% | none ≥80% precision | — | — | no | 0% / 0% / 68% |
| kev | v1.off_task | 0.90 | 0% | 3% | none ≥80% precision | — | — | no | 0% / 0% / 61% |
| decision | v1.off_task | 0.88 | 0% | 3% | none ≥80% precision | — | — | no | 0% / 0% / 35% |
| decision | v1.should_ask | 0.88 | 0% | 3% | none ≥80% precision | — | — | no | 0% / 0% / 35% |
| decision | v6.off_task | 0.88 | 50% | 3% | none ≥80% precision | — | — | no | 0% / 0% / 39% |
| decider:0.8b | v5.off_task | 0.86 | 0% | 0% | none ≥80% precision | — | — | no | 0% / 0% / 32% |
| decider:0.8b | v5.should_ask | 0.84 | 0% | 0% | none ≥80% precision | — | — | no | 0% / 0% / 35% |
| kev | v1.should_ask | 0.78 | 0% | 3% | none ≥80% precision | — | — | no | 0% / 0% / 100% |
| kev | v5.off_task | 0.72 | 0% | 0% | none ≥80% precision | — | — | no | 0% / 0% / 100% |
| kev | v5.should_ask | 0.62 | 0% | 0% | none ≥80% precision | — | — | no | 0% / 0% / 100% |
| decision | v5.off_task | 0.21 | 0% | 0% | none ≥80% precision | — | — | no | 0% / 0% / 71% |
| decision | v5.should_ask | 0.21 | 0% | 0% | none ≥80% precision | — | — | no | 0% / 0% / 71% |
| decider:2b | v1.destructive_false_alarm | — | — | 0% | none ≥80% precision | — | — | no | 0% / 0% / 0% |
| decider:0.8b | v1.destructive_false_alarm | — | — | 0% | none ≥80% precision | — | — | no | 0% / 0% / 3% |
| decision | v1.destructive_false_alarm | — | — | 0% | none ≥80% precision | — | — | no | 0% / 0% / 0% |
| kev | v1.destructive_false_alarm | — | — | 0% | none ≥80% precision | — | — | no | 0% / 0% / 100% |

## Latency per call (all questions of a decision in one call, CPU)

| model | decision | calls | errors | p50 ms | p95 ms | served by |
|---|---|---|---|---|---|---|
| decider:0.8b | command_review | 56 | 0 | 2912 | 3039 | decider:0.8b |
| decider:0.8b | real_workflow | 31 | 0 | 3036 | 4284 | decider:0.8b |
| decider:2b | command_review | 56 | 0 | 6200 | 6937 | decider:2b |
| decider:2b | real_workflow | 31 | 0 | 6351 | 8657 | decider:2b |
| decision | command_review | 56 | 0 | 4622 | 4878 | decision:latest |
| decision | real_workflow | 31 | 0 | 4080 | 5350 | decision:latest |
| kev | command_review | 56 | 0 | 3316 | 3511 | kev:latest |
| kev | real_workflow | 31 | 0 | 3278 | 4576 | kev:latest |
