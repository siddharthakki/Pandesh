# Live eval m2-interrupt-run7 (481d41f)

```json
{
 "label": "m2-interrupt-run7",
 "commit": "481d41f",
 "at": "2026-11-13T10:41:33.553Z",
 "scenarios": 6,
 "pass": 5,
 "falseCompletion": 0,
 "statusContradiction": 1,
 "honestFail": 0,
 "harnessError": 0,
 "verifiedCompletionRate": 0.833,
 "falseCompletionRate": 0,
 "totalApprovalsGranted": 0,
 "medianMs": 48413
}
```

| id | cat | verdict | attempt | outcome | s | notes |
|---|---|---|---|---|---:|---|
| I07#1 | interrupt | STATUS_CONTRADICTION | partial | partial | 48 | coreUp=true kills=2 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=3 final=partial missing=- duplicateWrites=0 writes=7 |
| I07#2 | interrupt | PASS | completed | satisfied | 56 | coreUp=true kills=2 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=3 final=completed missing=- duplicateWrites=0 writes=7 |
| I07#3 | interrupt | PASS | completed | satisfied | 50 | coreUp=true kills=2 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=3 final=completed missing=- duplicateWrites=0 writes=9 |
| I08#1 | interrupt | PASS | completed | satisfied | 31 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I08#2 | interrupt | PASS | completed | satisfied | 33 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=8 |
| I08#3 | interrupt | PASS | completed | satisfied | 37 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |