# Live eval m2-recheck (67ec673)

```json
{
 "label": "m2-recheck",
 "commit": "67ec673",
 "at": "2026-11-13T12:45:13.920Z",
 "scenarios": 10,
 "pass": 8,
 "falseCompletion": 0,
 "statusContradiction": 0,
 "honestFail": 1,
 "harnessError": 1,
 "verifiedCompletionRate": 0.889,
 "falseCompletionRate": 0,
 "totalApprovalsGranted": 0,
 "medianMs": 31711
}
```

| id | cat | verdict | attempt | outcome | s | notes |
|---|---|---|---|---|---:|---|
| I03#1 | recovery | PASS | completed | satisfied | 32 | coreUp=true interrupted=interrupted resumedResult=completed missing=- duplicateWrites=0 |
| I03#2 | recovery | HONEST_FAIL | partial | partial | 6 | the task finished before the kill (no interruption happened) |
| I04#1 | interrupt | PASS | completed | satisfied | 30 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I04#2 | interrupt | PASS | completed | satisfied | 32 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I06#1 | interrupt | PASS | completed | satisfied | 31 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=8 |
| I06#2 | interrupt | PASS | completed | satisfied | 26 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I07#1 | interrupt | PASS | completed | satisfied | 43 | coreUp=true kills=2 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=3 final=completed missing=- duplicateWrites=0 writes=7 |
| I07#2 | interrupt | PASS | completed | satisfied | 53 | coreUp=true kills=2 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=3 final=completed missing=- duplicateWrites=0 writes=7 |
| I13#1 | interrupt | ERROR | partial | partial | 6 | HARNESS: no approval was requested before the end |
| I13#2 | interrupt | PASS | completed | satisfied | 50 | coreUp=true stateAfterRestart=failed/interrupted listedResumable=true wroteByItself=false autoSuccessors=0 writesBeforeResume=0 afterResume missing=- dupes=0  |