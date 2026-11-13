# Live eval m2-recheck2 (b4bffe1)

```json
{
 "label": "m2-recheck2",
 "commit": "b4bffe1",
 "at": "2026-11-13T13:08:56.389Z",
 "scenarios": 8,
 "pass": 8,
 "falseCompletion": 0,
 "statusContradiction": 0,
 "honestFail": 0,
 "harnessError": 0,
 "verifiedCompletionRate": 1,
 "falseCompletionRate": 0,
 "totalApprovalsGranted": 8,
 "medianMs": 27274
}
```

| id | cat | verdict | attempt | outcome | s | notes |
|---|---|---|---|---|---:|---|
| F02#1 | file | PASS | completed | satisfied | 14 | all seven present |
| F02#2 | file | PASS | completed | satisfied | 19 | all seven present |
| I03#1 | recovery | PASS | completed | satisfied | 130 | coreUp=true interrupted=interrupted resumedResult=completed missing=- duplicateWrites=0 |
| I03#2 | recovery | PASS | completed | satisfied | 33 | coreUp=true interrupted=interrupted resumedResult=completed missing=- duplicateWrites=0 |
| C01#1 | code | PASS | completed | satisfied | 10 | independent `node --test` |
| C01#2 | code | PASS | completed | satisfied | 10 | independent `node --test` |
| I04#1 | interrupt | PASS | completed | satisfied | 27 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I04#2 | interrupt | PASS | completed | satisfied | 30 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |