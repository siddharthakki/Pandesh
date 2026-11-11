# Ollaya decision models: measured results

Endpoint http://127.0.0.1:11435; 2326 answers. Each dataset is split in half (alternating per label); each half picks a threshold that the other half is scored with, and the pooled out-of-fold predictions decide the bar.

## command_review

Caution class = the outcome that should make Pandesh more careful. Bar: out-of-fold recall ≥ 90% at precision ≥ 80% (threshold tuned on one half, measured on the other, both ways).

| model | wording | AUC | recall@0.5 | FPR@0.5 | thresholds (fold A / B) | out-of-fold recall (95% CI) | out-of-fold precision | bar | ≥0.8 flags / false flags / abstain |
|---|---|---|---|---|---|---|---|---|---|
| decider:2b | v2.destructive | 1.00 | 68% | 0% | 0.19 / 0.25 | 89% (69%–97%) | 100% | no | 32% / 0% / 20% |
| decider:2b | v1.off_task | 0.99 | 88% | 3% | 0.31 / 0.18 | 96% (81%–99%) | 93% | **yes** | 88% / 0% / 11% |
| decider:0.8b | v2.destructive | 0.99 | 79% | 0% | 0.10 / 0.07 | 95% (75%–99%) | 86% | **yes** | 21% / 0% / 21% |
| decider:2b | v1.should_ask | 0.99 | 91% | 8% | 0.31 / 0.49 | 94% (80%–98%) | 94% | **yes** | 75% / 0% / 27% |
| decider:0.8b | v1.destructive | 0.98 | 47% | 0% | 0.15 / 0.38 | 79% (57%–91%) | 79% | no | 16% / 0% / 29% |
| decider:2b | v3.should_ask | 0.97 | 78% | 0% | 0.05 / 0.09 | 88% (72%–95%) | 85% | no | 56% / 0% / 16% |
| decider:2b | v1.destructive | 0.97 | 53% | 3% | 0.16 / 0.28 | 95% (75%–99%) | 75% | no | 11% / 0% / 39% |
| decision | v1.should_ask | 0.97 | 59% | 0% | 0.21 / 0.27 | 84% (68%–93%) | 90% | no | 34% / 0% / 45% |
| decision | v1.off_task | 0.97 | 73% | 0% | 0.25 / 0.53 | 73% (54%–86%) | 95% | no | 42% / 0% / 32% |
| decider:0.8b | v1.should_ask | 0.97 | 81% | 8% | 0.24 / 0.49 | 88% (72%–95%) | 80% | no | 22% / 0% / 63% |
| decision | v2.destructive | 0.97 | 68% | 0% | 0.10 / 0.37 | 89% (69%–97%) | 68% | no | 0% / 0% / 30% |
| decider:0.8b | v1.off_task | 0.97 | 81% | 7% | 0.24 / 0.30 | 96% (81%–99%) | 76% | no | 15% / 0% / 61% |
| decider:0.8b | v3.should_ask | 0.96 | 41% | 0% | 0.02 / 0.08 | 91% (76%–97%) | 76% | no | 0% / 0% / 39% |
| decider:2b | v2.should_ask | 0.96 | 41% | 0% | 0.17 / 0.11 | 91% (76%–97%) | 91% | **yes** | 19% / 0% / 34% |
| decision | v3.should_ask | 0.96 | 72% | 0% | 0.25 / 0.36 | 84% (68%–93%) | 87% | no | 53% / 0% / 38% |
| kev | v3.should_ask | 0.96 | 19% | 0% | 0.26 / 0.28 | 97% (84%–99%) | 82% | **yes** | 0% / 0% / 84% |
| decision | v1.destructive | 0.96 | 0% | 0% | 0.21 / 0.15 | 79% (57%–91%) | 94% | no | 0% / 0% / 29% |
| kev | v1.should_ask | 0.96 | 50% | 0% | 0.32 / 0.37 | 97% (84%–99%) | 82% | **yes** | 0% / 0% / 100% |
| von | v1.off_task | 0.95 | 58% | 0% | 0.30 / 0.41 | 73% (54%–86%) | 86% | no | 15% / 0% / 89% |
| kev | v1.off_task | 0.95 | 27% | 0% | 0.32 / 0.31 | 88% (71%–96%) | 92% | no | 0% / 0% / 63% |
| laya:typed-decisions | v1.destructive | 0.95 | 53% | 3% | 0.39 / 0.30 | 84% (62%–94%) | 89% | no | 0% / 0% / 50% |
| laya:typed-decisions | v2.destructive | 0.95 | 53% | 3% | 0.46 / 0.28 | 63% (41%–81%) | 86% | no | 0% / 0% / 45% |
| laya:typed-decisions | v1.off_task | 0.94 | 73% | 3% | 0.44 / 0.43 | 88% (71%–96%) | 88% | no | 35% / 0% / 84% |
| laya:typed-decisions | v1.should_ask | 0.94 | 75% | 8% | 0.39 / 0.44 | 94% (80%–98%) | 79% | no | 28% / 0% / 84% |
| kev | v1.destructive | 0.94 | 53% | 0% | 0.37 / 0.43 | 84% (62%–94%) | 84% | no | 0% / 0% / 100% |
| laya | v1.destructive | 0.93 | 84% | 11% | 0.61 / 0.39 | 84% (62%–94%) | 84% | no | 58% / 5% / 25% |
| kev | v2.destructive | 0.93 | 53% | 0% | 0.32 / 0.32 | 79% (57%–91%) | 83% | no | 21% / 0% / 55% |
| laya | v1.should_ask | 0.93 | 78% | 13% | 0.17 / 0.39 | 84% (68%–93%) | 79% | no | 59% / 4% / 32% |
| nli:modernbert-large | v2.destructive | 0.93 | 0% | 0% | 0.07 / 0.04 | 63% (41%–81%) | 67% | no | 0% / 0% / 0% |
| nli | v3.should_ask | 0.93 | 100% | 71% | 0.53 / 0.53 | 91% (76%–97%) | 88% | **yes** | 0% / 0% / 100% |
| nli:modernbert-large | v1.off_task | 0.92 | 85% | 10% | 0.41 / 0.50 | 88% (71%–96%) | 74% | no | 35% / 0% / 77% |
| nli | v2.destructive | 0.92 | 5% | 0% | 0.03 / 0.01 | 63% (41%–81%) | 92% | no | 0% / 0% / 9% |
| nli | v1.destructive | 0.91 | 0% | 0% | 0.02 / 0.03 | 74% (51%–88%) | 93% | no | 0% / 0% / 5% |
| decider:2b | v2.off_task | 0.91 | 15% | 0% | 0.13 / 0.19 | 77% (58%–89%) | 80% | no | 0% / 0% / 34% |
| von | v1.should_ask | 0.91 | 72% | 13% | 0.35 / 0.41 | 88% (72%–95%) | 82% | no | 28% / 0% / 82% |
| nli:modernbert-large | v3.should_ask | 0.90 | 100% | 96% | 0.66 / 0.64 | 81% (65%–91%) | 81% | no | 6% / 0% / 96% |
| laya | v1.off_task | 0.90 | 58% | 3% | 0.22 / 0.22 | 85% (66%–94%) | 81% | no | 54% / 0% / 25% |
| laya | v2.destructive | 0.90 | 84% | 14% | 0.97 / 0.54 | 42% (23%–64%) | 73% | no | 53% / 8% / 27% |
| gliclass | v1.off_task | 0.89 | 100% | 77% | 0.89 / 0.97 | 69% (50%–83%) | 82% | no | 92% / 37% / 32% |
| laya | v2.should_ask | 0.87 | 63% | 17% | 0.17 / 0.54 | 75% (58%–87%) | 77% | no | 41% / 4% / 39% |
| nli:modernbert-large | v1.should_ask | 0.86 | 72% | 8% | 0.32 / 0.46 | 78% (61%–89%) | 76% | no | 28% / 0% / 77% |
| laya:typed-decisions | v2.should_ask | 0.86 | 31% | 4% | 0.23 / 0.28 | 81% (65%–91%) | 81% | no | 0% / 0% / 82% |
| von | v3.should_ask | 0.85 | 78% | 29% | 0.47 / 0.50 | 84% (68%–93%) | 77% | no | 47% / 4% / 68% |
| laya:typed-decisions | v3.should_ask | 0.83 | 78% | 21% | 0.51 / 0.54 | 66% (48%–80%) | 88% | no | 3% / 0% / 98% |
| gliclass | v1.should_ask | 0.82 | 100% | 79% | 0.85 / 0.97 | 63% (45%–77%) | 83% | no | 81% / 38% / 38% |
| nli | v2.should_ask | 0.82 | 3% | 0% | 0.10 / 0.09 | 63% (45%–77%) | 83% | no | 0% / 0% / 13% |
| nli:modernbert-large | v2.should_ask | 0.81 | 0% | 0% | 0.06 / 0.05 | 81% (65%–91%) | 81% | no | 0% / 0% / 0% |
| von | v2.destructive | 0.81 | 37% | 0% | 0.41 / 0.33 | 53% (32%–73%) | 91% | no | 26% / 0% / 77% |
| laya | v2.off_task | 0.80 | 35% | 13% | 0.27 / 0.70 | 54% (35%–71%) | 74% | no | 23% / 0% / 45% |
| nli:modernbert-large | v1.destructive | 0.80 | 0% | 0% | 0.15 / 0.16 | 42% (23%–64%) | 100% | no | 0% / 0% / 5% |
| decider:0.8b | v2.should_ask | 0.79 | 78% | 33% | 0.63 / 0.49 | 69% (51%–82%) | 73% | no | 16% / 4% / 89% |
| von | v1.destructive | 0.79 | 58% | 8% | 0.59 / 0.73 | 42% (23%–64%) | 80% | no | 26% / 0% / 55% |
| laya:typed-decisions | v2.off_task | 0.78 | 8% | 0% | 0.33 / 0.45 | 23% (11%–42%) | 75% | no | 0% / 0% / 80% |
| nli | v2.off_task | 0.78 | 0% | 0% | 0.10 / 0.10 | 58% (39%–74%) | 88% | no | 0% / 0% / 4% |
| nli | v1.off_task | 0.77 | 100% | 100% | 0.97 / 0.98 | 54% (35%–71%) | 70% | no | 100% / 100% / 0% |
| nli:modernbert-large | v2.off_task | 0.77 | 0% | 0% | 0.07 / 0.10 | 35% (19%–54%) | 75% | no | 0% / 0% / 0% |
| nli | v1.should_ask | 0.74 | 100% | 100% | 0.97 / 0.97 | 56% (39%–72%) | 82% | no | 100% / 100% / 0% |
| decider:0.8b | v2.off_task | 0.65 | 65% | 43% | 0.68 / 0.85 | 12% (4%–29%) | 60% | no | 8% / 3% / 95% |
| laya | v3.should_ask | 0.65 | 44% | 4% | 0.40 / 0.53 | 47% (31%–64%) | 79% | no | 22% / 0% / 68% |
| kev | v2.should_ask | 0.54 | 41% | 29% | 0.64 / 0.70 | 19% (9%–35%) | 100% | no | 13% / 0% / 93% |
| gliclass | v3.should_ask | 0.49 | 100% | 100% | none ≥80% precision | — | — | no | 100% / 92% / 4% |
| kev | v2.off_task | 0.33 | 15% | 30% | none ≥80% precision | — | — | no | 0% / 0% / 100% |
| gliclass | v1.destructive | 0.32 | 5% | 3% | none ≥80% precision | — | — | no | 0% / 0% / 29% |
| gliclass | v2.destructive | 0.31 | 5% | 14% | none ≥80% precision | — | — | no | 5% / 0% / 29% |
| decision | v2.should_ask | 0.28 | 47% | 96% | none ≥80% precision | — | — | no | 3% / 4% / 95% |
| von | v2.should_ask | 0.21 | 34% | 96% | 0.86 / 0.88 | 6% (2%–20%) | 100% | no | 16% / 13% / 77% |
| gliclass | v2.should_ask | 0.15 | 3% | 33% | none ≥80% precision | — | — | no | 3% / 13% / 36% |
| gliclass | v2.off_task | 0.11 | 0% | 27% | none ≥80% precision | — | — | no | 0% / 10% / 34% |
| von | v2.off_task | 0.01 | 12% | 97% | none ≥80% precision | — | — | no | 0% / 17% / 68% |
| decision | v2.off_task | 0.01 | 4% | 97% | none ≥80% precision | — | — | no | 0% / 7% / 91% |

## web_query_privacy

Caution class = the outcome that should make Pandesh more careful. Bar: out-of-fold recall ≥ 90% at precision ≥ 80% (threshold tuned on one half, measured on the other, both ways).

| model | wording | AUC | recall@0.5 | FPR@0.5 | thresholds (fold A / B) | out-of-fold recall (95% CI) | out-of-fold precision | bar | ≥0.8 flags / false flags / abstain |
|---|---|---|---|---|---|---|---|---|---|
| decider:2b | v3.private | 0.99 | 82% | 0% | 0.18 / 0.29 | 96% (82%–99%) | 93% | **yes** | 68% / 0% / 18% |
| decider:0.8b | v3.private | 0.98 | 96% | 14% | 0.58 / 0.69 | 86% (69%–94%) | 96% | no | 61% / 0% / 39% |
| decider:2b | v1.private | 0.98 | 14% | 0% | 0.05 / 0.03 | 89% (73%–96%) | 93% | no | 0% / 0% / 16% |
| decider:0.8b | v1.private | 0.97 | 25% | 0% | 0.04 / 0.08 | 93% (77%–98%) | 87% | **yes** | 4% / 0% / 32% |
| decision | v1.private | 0.96 | 50% | 4% | 0.25 / 0.22 | 93% (77%–98%) | 87% | **yes** | 0% / 0% / 55% |
| kev | v2.private | 0.96 | 7% | 0% | 0.24 / 0.24 | 93% (77%–98%) | 84% | **yes** | 0% / 0% / 64% |
| von | v2.private | 0.95 | 36% | 0% | 0.29 / 0.23 | 82% (64%–92%) | 85% | no | 7% / 0% / 68% |
| decider:2b | v2.private | 0.95 | 0% | 0% | 0.03 / 0.04 | 86% (69%–94%) | 89% | no | 0% / 0% / 4% |
| decision | v3.private | 0.94 | 93% | 18% | 0.47 / 0.58 | 93% (77%–98%) | 84% | **yes** | 61% / 7% / 34% |
| decision | v2.private | 0.93 | 4% | 0% | 0.15 / 0.12 | 79% (60%–90%) | 88% | no | 0% / 0% / 23% |
| kev | v1.private | 0.92 | 29% | 0% | 0.14 / 0.19 | 86% (69%–94%) | 77% | no | 0% / 0% / 50% |
| gliclass | v2.private | 0.92 | 0% | 0% | 0.01 / 0.01 | 89% (73%–96%) | 89% | no | 0% / 0% / 4% |
| nli | v1.private | 0.92 | 0% | 0% | 0.01 / 0.01 | 82% (64%–92%) | 88% | no | 0% / 0% / 2% |
| laya:typed-decisions | v1.private | 0.92 | 11% | 0% | 0.20 / 0.21 | 82% (64%–92%) | 82% | no | 0% / 0% / 48% |
| nli:modernbert-large | v1.private | 0.91 | 0% | 0% | 0.07 / 0.08 | 79% (60%–90%) | 81% | no | 0% / 0% / 13% |
| von | v1.private | 0.91 | 68% | 7% | 0.10 / 0.06 | 86% (69%–94%) | 80% | no | 36% / 4% / 23% |
| kev | v3.private | 0.91 | 89% | 25% | 0.50 / 0.64 | 82% (64%–92%) | 79% | no | 39% / 0% / 70% |
| nli | v2.private | 0.91 | 0% | 0% | 0.01 / 0.01 | 86% (69%–94%) | 83% | no | 0% / 0% / 0% |
| qwen3guard | guard.pii | 0.90 | 61% | 0% | 0.31 / 0.27 | 75% (57%–87%) | 91% | no | 36% / 0% / 30% |
| qwen3guard | guard.unsafe_strict | 0.89 | 21% | 0% | 0.06 / 0.03 | 82% (64%–92%) | 85% | no | 7% / 0% / 25% |
| laya:typed-decisions | v3.private | 0.89 | 100% | 71% | 0.64 / 0.59 | 86% (69%–94%) | 86% | no | 14% / 0% / 93% |
| laya | v1.private | 0.88 | 21% | 0% | 0.13 / 0.17 | 64% (46%–79%) | 86% | no | 0% / 0% / 29% |
| von | v3.private | 0.86 | 100% | 46% | 0.95 / 0.90 | 57% (39%–73%) | 84% | no | 82% / 36% / 30% |
| laya:typed-decisions | v2.private | 0.86 | 0% | 0% | 0.23 / 0.20 | 71% (53%–85%) | 83% | no | 0% / 0% / 48% |
| laya | v3.private | 0.85 | 100% | 86% | 0.70 / 0.74 | 68% (49%–82%) | 86% | no | 43% / 7% / 73% |
| decider:0.8b | v2.private | 0.84 | 0% | 0% | 0.06 / 0.05 | 71% (53%–85%) | 91% | no | 0% / 0% / 4% |
| nli | v3.private | 0.83 | 71% | 14% | 0.60 / 0.52 | 61% (42%–76%) | 89% | no | 7% / 0% / 89% |
| gliclass | v3.private | 0.82 | 100% | 93% | 0.72 / 0.71 | 64% (46%–79%) | 86% | no | 29% / 4% / 84% |
| laya | v2.private | 0.82 | 0% | 0% | 0.12 / 0.09 | 75% (57%–87%) | 81% | no | 0% / 0% / 9% |
| gliclass | v1.private | 0.81 | 0% | 0% | 0.17 / 0.01 | 36% (21%–54%) | 77% | no | 0% / 0% / 0% |
| nli:modernbert-large | v3.private | 0.71 | 100% | 100% | 0.78 / 0.81 | 32% (18%–51%) | 69% | no | 29% / 11% / 80% |
| nli:modernbert-large | v2.private | 0.60 | 0% | 0% | none ≥80% precision | — | — | no | 0% / 0% / 0% |

## prompt_injection

Caution class = the outcome that should make Pandesh more careful. Bar: out-of-fold recall ≥ 90% at precision ≥ 80% (threshold tuned on one half, measured on the other, both ways).

| model | wording | AUC | recall@0.5 | FPR@0.5 | thresholds (fold A / B) | out-of-fold recall (95% CI) | out-of-fold precision | bar | ≥0.8 flags / false flags / abstain |
|---|---|---|---|---|---|---|---|---|---|
| decider:2b | v1.injection | 0.97 | 100% | 12% | 0.58 / 0.51 | 92% (75%–98%) | 92% | **yes** | 68% / 4% / 28% |
| nli | v3.injection | 0.96 | 80% | 8% | 0.42 / 0.40 | 96% (80%–99%) | 89% | **yes** | 24% / 0% / 68% |
| decider:2b | v3.injection | 0.95 | 80% | 4% | 0.19 / 0.20 | 92% (75%–98%) | 85% | **yes** | 24% / 0% / 42% |
| qwen3guard | guard.unsafe_strict | 0.94 | 60% | 4% | 0.07 / 0.27 | 76% (57%–89%) | 79% | no | 56% / 4% / 12% |
| gliclass | v3.injection | 0.94 | 96% | 36% | 0.81 / 0.75 | 88% (70%–96%) | 81% | no | 88% / 20% / 22% |
| nli | v1.injection | 0.93 | 80% | 12% | 0.16 / 0.38 | 88% (70%–96%) | 85% | no | 68% / 12% / 12% |
| nli:modernbert-large | v1.injection | 0.93 | 84% | 8% | 0.48 / 0.59 | 80% (61%–91%) | 91% | no | 72% / 8% / 10% |
| decider:2b | v2.injection | 0.92 | 60% | 8% | 0.11 / 0.16 | 92% (75%–98%) | 85% | **yes** | 32% / 4% / 34% |
| nli:modernbert-large | v3.injection | 0.88 | 40% | 4% | 0.22 / 0.31 | 72% (52%–86%) | 82% | no | 4% / 0% / 48% |
| decider:0.8b | v2.injection | 0.88 | 44% | 8% | 0.02 / 0.04 | 84% (65%–94%) | 81% | no | 24% / 8% / 20% |
| laya:typed-decisions | v1.injection | 0.88 | 72% | 16% | 0.71 / 0.37 | 76% (57%–89%) | 79% | no | 44% / 4% / 58% |
| qwen3guard | guard.jailbreak | 0.88 | 12% | 0% | 0.01 / 0.01 | 88% (70%–96%) | 79% | no | 4% / 0% / 14% |
| von | v1.injection | 0.87 | 96% | 40% | 0.93 / 0.88 | 8% (2%–25%) | 50% | no | 72% / 24% / 48% |
| laya | v1.injection | 0.87 | 84% | 24% | 0.97 / 0.88 | 68% (48%–83%) | 81% | no | 80% / 16% / 14% |
| decider:0.8b | v3.injection | 0.86 | 88% | 24% | 0.60 / 0.54 | 72% (52%–86%) | 86% | no | 36% / 8% / 58% |
| decider:0.8b | v1.injection | 0.86 | 96% | 32% | 0.61 / 0.90 | 64% (45%–80%) | 76% | no | 56% / 20% / 48% |
| von | v3.injection | 0.85 | 100% | 36% | 0.77 / 0.56 | 48% (30%–67%) | 67% | no | 12% / 0% / 84% |
| laya | v2.injection | 0.85 | 72% | 28% | 0.94 / 0.74 | 68% (48%–83%) | 81% | no | 68% / 20% / 10% |
| laya | v3.injection | 0.83 | 64% | 12% | 0.50 / 0.93 | 36% (20%–55%) | 82% | no | 32% / 0% / 60% |
| gliclass | v2.injection | 0.83 | 0% | 0% | 0.10 / 0.07 | 64% (45%–80%) | 73% | no | 0% / 0% / 10% |
| laya:typed-decisions | v3.injection | 0.82 | 52% | 0% | 0.42 / 0.43 | 68% (48%–83%) | 94% | no | 4% / 0% / 90% |
| decision | v1.injection | 0.81 | 80% | 36% | 0.65 / 0.71 | 44% (27%–63%) | 79% | no | 20% / 4% / 80% |
| kev | v1.injection | 0.81 | 68% | 20% | 0.49 / 0.84 | 44% (27%–63%) | 73% | no | 4% / 0% / 98% |
| kev | v3.injection | 0.81 | 40% | 4% | 0.49 / 0.38 | 56% (37%–73%) | 74% | no | 0% / 0% / 92% |
| kev | v2.injection | 0.80 | 48% | 8% | 0.43 / 0.46 | 52% (33%–70%) | 81% | no | 12% / 4% / 80% |
| von | v2.injection | 0.80 | 36% | 20% | 0.35 / 0.87 | 44% (27%–63%) | 73% | no | 20% / 8% / 86% |
| laya:typed-decisions | v2.injection | 0.79 | 52% | 4% | 0.62 / 0.48 | 48% (30%–67%) | 92% | no | 12% / 0% / 60% |
| decision | v2.injection | 0.76 | 24% | 8% | 0.46 / 0.33 | 36% (20%–55%) | 75% | no | 4% / 8% / 50% |
| decision | v3.injection | 0.68 | 48% | 20% | 0.77 / 0.45 | 36% (20%–55%) | 56% | no | 8% / 4% / 80% |
| nli | v2.injection | 0.67 | 8% | 0% | none ≥80% precision | — | — | no | 4% / 0% / 10% |
| nli:modernbert-large | v2.injection | 0.59 | 12% | 0% | none ≥80% precision | — | — | no | 8% / 0% / 4% |
| gliclass | v1.injection | 0.56 | 4% | 0% | 0.58 / 0.28 | 12% (4%–30%) | 60% | no | 0% / 0% / 38% |

## routing

| model | wording | accuracy | test accuracy | answered at confidence ≥0.6 | accuracy when answered | weakest class |
|---|---|---|---|---|---|---|
| decider:0.8b | v2.agent | 95% | 97% | 87% | 98% | chat 83% |
| decider:0.8b | v1.agent | 92% | 97% | 68% | 100% | personal 83% |
| decider:2b | v2.agent | 92% | 97% | 83% | 94% | personal 75% |
| decider:2b | v1.agent | 88% | 93% | 83% | 98% | chat 75% |
| kev | v2.agent | 87% | 80% | 52% | 97% | chat 67% |
| laya:typed-decisions | v1.agent | 85% | 90% | 13% | 100% | research 67% |
| laya | v1.agent | 80% | 83% | 40% | 96% | chat 58% |
| laya:typed-decisions | v2.agent | 80% | 77% | 8% | 100% | chat 67% |
| decision | v1.agent | 78% | 83% | 75% | 91% | personal 67% |
| von | v2.agent | 75% | 73% | 88% | 74% | research 50% |
| kev | v1.agent | 75% | 73% | 42% | 100% | research 33% |
| laya | v2.agent | 73% | 70% | 20% | 92% | research 50% |
| decision | v2.agent | 72% | 77% | 75% | 84% | chat 25% |
| von | v1.agent | 67% | 70% | 80% | 67% | research 50% |
| gliclass | v2.agent | 65% | 63% | 0% | — | chat 0% |
| nli | v1.agent | 63% | 63% | 17% | 100% | chat 8% |
| gliclass | v1.agent | 58% | 60% | 22% | 100% | chat 0% |
| nli:modernbert-large | v2.agent | 45% | 47% | 7% | 100% | research 8% |
| nli:modernbert-large | v1.agent | 38% | 37% | 3% | 100% | chat 0% |
| nli | v2.agent | 20% | 20% | 42% | 48% | research 0% |

## Latency per call (all questions of a decision in one call, CPU)

| model | decision | calls | errors | p50 ms | p95 ms | served by |
|---|---|---|---|---|---|---|
| decider:0.8b | command_review | 56 | 0 | 1715 | 2028 | decider:0.8b |
| decider:0.8b | prompt_injection | 50 | 0 | 1097 | 1253 | decider:0.8b |
| decider:0.8b | routing | 60 | 0 | 1417 | 2561 | decider:0.8b |
| decider:0.8b | web_query_privacy | 56 | 0 | 1377 | 1426 | decider:0.8b |
| decider:2b | command_review | 56 | 0 | 3788 | 5505 | decider:2b |
| decider:2b | prompt_injection | 50 | 0 | 2337 | 2892 | decider:2b |
| decider:2b | routing | 60 | 0 | 2760 | 4320 | decider:2b |
| decider:2b | web_query_privacy | 56 | 0 | 2964 | 3104 | decider:2b |
| decision | command_review | 56 | 0 | 2468 | 2587 | decision:latest |
| decision | prompt_injection | 50 | 0 | 1569 | 1637 | decision:latest |
| decision | routing | 60 | 0 | 1687 | 1730 | decision:latest |
| decision | web_query_privacy | 56 | 0 | 2006 | 2080 | decision:latest |
| gliclass | command_review | 56 | 0 | 777 | 921 | gliclass:latest |
| gliclass | prompt_injection | 50 | 0 | 436 | 477 | gliclass:latest |
| gliclass | routing | 60 | 0 | 573 | 594 | gliclass:latest |
| gliclass | web_query_privacy | 56 | 0 | 559 | 617 | gliclass:latest |
| kev | command_review | 56 | 0 | 2061 | 2315 | kev:latest |
| kev | prompt_injection | 50 | 0 | 1638 | 2630 | kev:latest |
| kev | routing | 60 | 0 | 1224 | 1309 | kev:latest |
| kev | web_query_privacy | 56 | 0 | 1601 | 1786 | kev:latest |
| laya | command_review | 56 | 0 | 724 | 828 | laya:en |
| laya | prompt_injection | 50 | 0 | 412 | 448 | laya:en |
| laya | routing | 60 | 0 | 560 | 581 | laya:en |
| laya | web_query_privacy | 56 | 0 | 532 | 591 | laya:en |
| laya:typed-decisions | command_review | 56 | 0 | 713 | 830 | laya:typed-decisions |
| laya:typed-decisions | prompt_injection | 50 | 0 | 406 | 443 | laya:typed-decisions |
| laya:typed-decisions | routing | 60 | 0 | 552 | 577 | laya:typed-decisions |
| laya:typed-decisions | web_query_privacy | 56 | 0 | 524 | 583 | laya:typed-decisions |
| nli | command_review | 56 | 0 | 822 | 1058 | nli:latest |
| nli | prompt_injection | 50 | 0 | 565 | 634 | nli:latest |
| nli | routing | 60 | 0 | 1375 | 1562 | nli:latest |
| nli | web_query_privacy | 56 | 0 | 584 | 660 | nli:latest |
| nli:modernbert-large | command_review | 56 | 0 | 589 | 739 | nli:modernbert-large |
| nli:modernbert-large | prompt_injection | 50 | 0 | 525 | 590 | nli:modernbert-large |
| nli:modernbert-large | routing | 60 | 0 | 859 | 949 | nli:modernbert-large |
| nli:modernbert-large | web_query_privacy | 56 | 0 | 444 | 529 | nli:modernbert-large |
| qwen3guard | prompt_injection | 50 | 0 | 1297 | 1428 | qwen3guard:latest |
| qwen3guard | web_query_privacy | 56 | 0 | 1331 | 1442 | qwen3guard:latest |
| von | command_review | 56 | 0 | 1206 | 1409 | von:latest |
| von | prompt_injection | 50 | 0 | 662 | 735 | von:latest |
| von | routing | 60 | 0 | 605 | 635 | von:latest |
| von | web_query_privacy | 56 | 0 | 873 | 979 | von:latest |
