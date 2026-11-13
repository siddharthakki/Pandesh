# Live eval m2-gate-run1 (bbd6aee)

```json
{
 "label": "m2-gate-run1",
 "commit": "bbd6aee",
 "at": "2026-11-13T10:58:13.142Z",
 "scenarios": 27,
 "pass": 24,
 "falseCompletion": 3,
 "statusContradiction": 0,
 "honestFail": 0,
 "harnessError": 0,
 "verifiedCompletionRate": 0.889,
 "falseCompletionRate": 0.111,
 "totalApprovalsGranted": 0,
 "medianMs": 32029
}
```

| id | cat | verdict | attempt | outcome | s | notes |
|---|---|---|---|---|---:|---|
| I03#1 | recovery | FALSE_COMPLETION | completed | satisfied | 35 | coreUp=true interrupted=interrupted resumedResult=completed missing=meeting-note,invoice-alpenmilch,invoice-donau,invoice-ulmer,plan,readme duplicateWrites=0 |
| I03#2 | recovery | PASS | completed | satisfied | 35 | coreUp=true interrupted=interrupted resumedResult=completed missing=- duplicateWrites=0 |
| I03#3 | recovery | PASS | completed | satisfied | 37 | coreUp=true interrupted=interrupted resumedResult=completed missing=- duplicateWrites=0 |
| I04#1 | interrupt | PASS | completed | satisfied | 32 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I04#2 | interrupt | PASS | completed | satisfied | 32 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I04#3 | interrupt | PASS | completed | satisfied | 32 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I05#1 | interrupt | PASS | completed | satisfied | 33 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I05#2 | interrupt | PASS | completed | satisfied | 29 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I05#3 | interrupt | PASS | completed | satisfied | 101 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=8 |
| I06#1 | interrupt | PASS | completed | satisfied | 25 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I06#2 | interrupt | PASS | completed | satisfied | 25 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I06#3 | interrupt | PASS | completed | satisfied | 33 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I07#1 | interrupt | PASS | completed | satisfied | 47 | coreUp=true kills=2 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=3 final=completed missing=- duplicateWrites=0 writes=7 |
| I07#2 | interrupt | PASS | completed | satisfied | 42 | coreUp=true kills=2 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=3 final=completed missing=- duplicateWrites=0 writes=7 |
| I07#3 | interrupt | PASS | completed | satisfied | 47 | coreUp=true kills=2 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=3 final=completed missing=- duplicateWrites=0 writes=7 |
| I08#1 | interrupt | PASS | completed | satisfied | 32 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=8 |
| I08#2 | interrupt | PASS | completed | satisfied | 29 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I08#3 | interrupt | PASS | completed | satisfied | 33 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=7 |
| I09#1 | interrupt | PASS | cancelled | in_progress | 6 | status=cancelled refused=true (POST /v1/attempts/att_c2dacb6b-042d-4ec8-a2a3-affe6d8c015c/resume -> 422 {"error":{"code":"invalid_transition","message") listedR |
| I09#2 | interrupt | PASS | cancelled | in_progress | 6 | status=cancelled refused=true (POST /v1/attempts/att_1e31f72a-3fcf-47df-87f4-7d1eb7d97d7a/resume -> 422 {"error":{"code":"invalid_transition","message") listedR |
| I09#3 | interrupt | PASS | cancelled | in_progress | 6 | status=cancelled refused=true (POST /v1/attempts/att_239254ca-419a-4088-82f4-37d3c0ff04ff/resume -> 422 {"error":{"code":"invalid_transition","message") listedR |
| I11#1 | interrupt | PASS | completed | in_progress | 28 | coreUp=true interrupted=interrupted reminders=1 final=completed |
| I11#2 | interrupt | PASS | completed | in_progress | 17 | coreUp=true interrupted=interrupted reminders=1 final=completed |
| I11#3 | interrupt | PASS | completed | in_progress | 18 | coreUp=true interrupted=interrupted reminders=1 final=completed |
| I13#1 | interrupt | FALSE_COMPLETION | completed | satisfied | 67 | coreUp=true stateAfterRestart=failed/interrupted listedResumable=true wroteByItself=false autoSuccessors=0 writesBeforeResume=0 afterResume missing=meeting-note |
| I13#2 | interrupt | FALSE_COMPLETION | completed | satisfied | 51 | coreUp=true stateAfterRestart=failed/interrupted listedResumable=true wroteByItself=false autoSuccessors=0 writesBeforeResume=0 afterResume missing=meeting-note |
| I13#3 | interrupt | PASS | completed | satisfied | 50 | coreUp=true stateAfterRestart=failed/interrupted listedResumable=true wroteByItself=false autoSuccessors=0 writesBeforeResume=0 afterResume missing=- dupes=0  |