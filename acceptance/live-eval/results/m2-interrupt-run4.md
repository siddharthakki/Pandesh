# Live eval m2-interrupt-run4 (107b6bc)

```json
{
 "label": "m2-interrupt-run4",
 "commit": "107b6bc",
 "at": "2026-11-13T10:03:17.998Z",
 "scenarios": 12,
 "pass": 9,
 "falseCompletion": 0,
 "statusContradiction": 2,
 "honestFail": 0,
 "harnessError": 1,
 "verifiedCompletionRate": 0.818,
 "falseCompletionRate": 0,
 "totalApprovalsGranted": 0,
 "medianMs": 30773
}
```

| id | cat | verdict | attempt | outcome | s | notes |
|---|---|---|---|---|---:|---|
| I05#1 | interrupt | PASS | completed | satisfied | 31 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I05#2 | interrupt | ERROR | partial | partial | 8 | HARNESS: the task finished before the kill (no interruption happened) |
| I05#3 | interrupt | PASS | completed | satisfied | 29 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I06#1 | interrupt | PASS | completed | satisfied | 27 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I06#2 | interrupt | PASS | completed | satisfied | 27 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I06#3 | interrupt | STATUS_CONTRADICTION | partial | partial | 27 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=partial missing=- duplicateWrites=0 writes=7 |
| I07#1 | interrupt | PASS | completed | satisfied | 266 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I07#2 | interrupt | PASS | completed | satisfied | 269 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I07#3 | interrupt | STATUS_CONTRADICTION | partial | partial | 270 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=partial missing=- duplicateWrites=0 writes=7 |
| I08#1 | interrupt | PASS | completed | satisfied | 39 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=8 |
| I08#2 | interrupt | PASS | completed | satisfied | 33 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I08#3 | interrupt | PASS | completed | satisfied | 29 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |