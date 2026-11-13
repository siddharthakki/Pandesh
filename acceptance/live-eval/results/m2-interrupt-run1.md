# Live eval m2-interrupt-run1 (376736c)

```json
{
 "label": "m2-interrupt-run1",
 "commit": "376736c",
 "at": "2026-11-13T09:34:11.944Z",
 "scenarios": 9,
 "pass": 4,
 "falseCompletion": 4,
 "statusContradiction": 0,
 "honestFail": 1,
 "harnessError": 0,
 "verifiedCompletionRate": 0.444,
 "falseCompletionRate": 0.444,
 "totalApprovalsGranted": 4,
 "medianMs": 15332
}
```

| id | cat | verdict | attempt | outcome | s | notes |
|---|---|---|---|---|---:|---|
| I03 | recovery | PASS | completed | satisfied | 31 | coreUp=true interrupted=interrupted resumedResult=completed missing=- duplicateWrites=0 |
| I04 | interrupt | HONEST_FAIL | partial | partial | 20 | coreUp=true kills=1 interrupted=interrupted listedResumable=true autoResumed=0 attemptsInChain=2 final=partial missing=meeting-note,invoice-alpenmilch,invoice-d |
| I05 | interrupt | FALSE_COMPLETION | completed | satisfied | 12 | the task finished before the kill (no interruption happened) |
| I06 | interrupt | FALSE_COMPLETION | completed | satisfied | 12 | the task finished before the kill (no interruption happened) |
| I07 | interrupt | FALSE_COMPLETION | completed | satisfied | 15 | the task finished before the kill (no interruption happened) |
| I08 | interrupt | FALSE_COMPLETION | completed | satisfied | 12 | the task finished before the kill (no interruption happened) |
| I09 | interrupt | PASS | cancelled | in_progress | 5 | status=cancelled refused=true (POST /v1/attempts/att_dcc657f3-6e69-4c0e-be28-c542a9dcf65c/resume -> 422 {"error":{"code":"invalid_transition","message") listedR |
| I11 | interrupt | PASS | completed |  | 21 | coreUp=true interrupted=completed reminders=1 final=undefined resume: POST /v1/attempts/att_c526d734-b233-4945-9e6a-754906b59cc3/resume -> 422 {"error":{"code": |
| I13 | interrupt | PASS | completed | satisfied | 54 | coreUp=true stateAfterRestart=failed/interrupted listedResumable=true wroteByItself=false autoSuccessors=0 writesBeforeResume=0 afterResume missing=- dupes=0  |