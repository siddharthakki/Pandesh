# Live eval m2-interrupt-run2 (a66daa1)

```json
{
 "label": "m2-interrupt-run2",
 "commit": "a66daa1",
 "at": "2026-11-13T09:41:15.174Z",
 "scenarios": 18,
 "pass": 9,
 "falseCompletion": 1,
 "statusContradiction": 0,
 "honestFail": 0,
 "harnessError": 8,
 "verifiedCompletionRate": 0.9,
 "falseCompletionRate": 0.1,
 "totalApprovalsGranted": 8,
 "medianMs": 34103
}
```

| id | cat | verdict | attempt | outcome | s | notes |
|---|---|---|---|---|---:|---|
| I03#1 | recovery | PASS | completed | satisfied | 35 | coreUp=true interrupted=interrupted resumedResult=completed missing=- duplicateWrites=0 |
| I03#2 | recovery | PASS | completed | satisfied | 33 | coreUp=true interrupted=interrupted resumedResult=completed missing=- duplicateWrites=0 |
| I04#1 | interrupt | PASS | completed | satisfied | 34 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=0 |
| I04#2 | interrupt | PASS | completed | satisfied | 34 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=completed missing=- duplicateWrites=0 writes=0 |
| I05#1 | interrupt | ERROR | completed | satisfied | 21 | HARNESS: the task finished before the kill (no interruption happened) |
| I05#2 | interrupt | ERROR | completed | satisfied | 14 | HARNESS: the task finished before the kill (no interruption happened) |
| I06#1 | interrupt | ERROR | completed | satisfied | 21 | HARNESS: the task finished before the kill (no interruption happened) |
| I06#2 | interrupt | ERROR | completed | satisfied | 11 | HARNESS: the task finished before the kill (no interruption happened) |
| I07#1 | interrupt | ERROR | completed | satisfied | 13 | HARNESS: the task finished before the kill (no interruption happened) |
| I07#2 | interrupt | ERROR | completed | satisfied | 10 | HARNESS: the task finished before the kill (no interruption happened) |
| I08#1 | interrupt | ERROR | completed | satisfied | 13 | HARNESS: the task finished before the kill (no interruption happened) |
| I08#2 | interrupt | ERROR | completed | satisfied | 11 | HARNESS: the task finished before the kill (no interruption happened) |
| I09#1 | interrupt | PASS | cancelled | in_progress | 5 | status=cancelled refused=true (POST /v1/attempts/att_6646d7c2-405b-4d6e-8fef-1098c729b91d/resume -> 422 {"error":{"code":"invalid_transition","message") listedR |
| I09#2 | interrupt | PASS | cancelled | in_progress | 5 | status=cancelled refused=true (POST /v1/attempts/att_360825d4-b484-4f35-9a68-a83d42b0fb59/resume -> 422 {"error":{"code":"invalid_transition","message") listedR |
| I11#1 | interrupt | PASS | completed | in_progress | 22 | coreUp=true interrupted=interrupted reminders=1 final=completed |
| I11#2 | interrupt | FALSE_COMPLETION | completed | satisfied | 17 | coreUp=true interrupted=interrupted reminders=2 final=completed |
| I13#1 | interrupt | PASS | completed | satisfied | 54 | coreUp=true stateAfterRestart=failed/interrupted listedResumable=true wroteByItself=false autoSuccessors=0 writesBeforeResume=0 afterResume missing=- dupes=0  |
| I13#2 | interrupt | PASS | completed | satisfied | 54 | coreUp=true stateAfterRestart=failed/interrupted listedResumable=true wroteByItself=false autoSuccessors=0 writesBeforeResume=0 afterResume missing=- dupes=0  |