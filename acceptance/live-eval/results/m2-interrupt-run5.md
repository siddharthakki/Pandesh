# Live eval m2-interrupt-run5 (107b6bc)

```json
{
 "label": "m2-interrupt-run5",
 "commit": "107b6bc",
 "at": "2026-11-13T10:08:41.700Z",
 "scenarios": 9,
 "pass": 7,
 "falseCompletion": 0,
 "statusContradiction": 0,
 "honestFail": 2,
 "harnessError": 0,
 "verifiedCompletionRate": 0.778,
 "falseCompletionRate": 0,
 "totalApprovalsGranted": 0,
 "medianMs": 34912
}
```

| id | cat | verdict | attempt | outcome | s | notes |
|---|---|---|---|---|---:|---|
| I03#1 | recovery | PASS | completed | satisfied | 35 | coreUp=true interrupted=interrupted resumedResult=completed missing=- duplicateWrites=0 |
| I03#2 | recovery | PASS | completed | satisfied | 25 | coreUp=true interrupted=interrupted resumedResult=completed missing=- duplicateWrites=0 |
| I03#3 | recovery | PASS | completed | satisfied | 31 | coreUp=true interrupted=interrupted resumedResult=completed missing=- duplicateWrites=0 |
| I04#1 | interrupt | HONEST_FAIL | partial | partial | 20 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=partial missing=meeting-note,invoice-alpenmilch,invoice-d |
| I04#2 | interrupt | HONEST_FAIL | partial | partial | 16 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=partial missing=meeting-note,invoice-alpenmilch,invoice-d |
| I04#3 | interrupt | PASS | completed | satisfied | 36 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=8 |
| I13#1 | interrupt | PASS | completed | satisfied | 51 | coreUp=true stateAfterRestart=failed/interrupted listedResumable=true wroteByItself=false autoSuccessors=0 writesBeforeResume=0 afterResume missing=- dupes=0  |
| I13#2 | interrupt | PASS | completed | satisfied | 46 | coreUp=true stateAfterRestart=failed/interrupted listedResumable=true wroteByItself=false autoSuccessors=0 writesBeforeResume=0 afterResume missing=- dupes=0  |
| I13#3 | interrupt | PASS | completed | satisfied | 49 | coreUp=true stateAfterRestart=failed/interrupted listedResumable=true wroteByItself=false autoSuccessors=0 writesBeforeResume=0 afterResume missing=- dupes=0  |