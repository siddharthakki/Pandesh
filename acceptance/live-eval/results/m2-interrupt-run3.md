# Live eval m2-interrupt-run3 (107b6bc)

```json
{
 "label": "m2-interrupt-run3",
 "commit": "107b6bc",
 "at": "2026-11-13T09:45:28.089Z",
 "scenarios": 15,
 "pass": 3,
 "falseCompletion": 0,
 "statusContradiction": 0,
 "honestFail": 0,
 "harnessError": 12,
 "verifiedCompletionRate": 1,
 "falseCompletionRate": 0,
 "totalApprovalsGranted": 9,
 "medianMs": 17577
}
```

| id | cat | verdict | attempt | outcome | s | notes |
|---|---|---|---|---|---:|---|
| I05#1 | interrupt | ERROR | completed | satisfied | 14 | HARNESS: the task finished before the kill (no interruption happened) |
| I05#2 | interrupt | ERROR | completed | satisfied | 12 | HARNESS: the task finished before the kill (no interruption happened) |
| I05#3 | interrupt | ERROR | completed | satisfied | 18 | HARNESS: the task finished before the kill (no interruption happened) |
| I06#1 | interrupt | ERROR | completed | satisfied | 16 | HARNESS: the task finished before the kill (no interruption happened) |
| I06#2 | interrupt | ERROR | completed | satisfied | 12 | HARNESS: the task finished before the kill (no interruption happened) |
| I06#3 | interrupt | ERROR | completed | satisfied | 12 | HARNESS: the task finished before the kill (no interruption happened) |
| I07#1 | interrupt | ERROR | completed | satisfied | 18 | HARNESS: the task finished before the kill (no interruption happened) |
| I07#2 | interrupt | ERROR | partial | partial | 8 | HARNESS: the task finished before the kill (no interruption happened) |
| I07#3 | interrupt | ERROR | completed | satisfied | 10 | HARNESS: the task finished before the kill (no interruption happened) |
| I08#1 | interrupt | ERROR | completed | satisfied | 12 | HARNESS: the task finished before the kill (no interruption happened) |
| I08#2 | interrupt | ERROR | partial | partial | 8 | HARNESS: the task finished before the kill (no interruption happened) |
| I08#3 | interrupt | ERROR | partial | partial | 8 | HARNESS: the task finished before the kill (no interruption happened) |
| I11#1 | interrupt | PASS | completed | in_progress | 24 | coreUp=true interrupted=interrupted reminders=1 final=completed |
| I11#2 | interrupt | PASS | completed | in_progress | 18 | coreUp=true interrupted=interrupted reminders=1 final=completed |
| I11#3 | interrupt | PASS | completed | in_progress | 17 | coreUp=true interrupted=interrupted reminders=1 final=completed |