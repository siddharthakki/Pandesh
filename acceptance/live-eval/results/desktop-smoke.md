# Desktop path desktop-smoke

```json
{
 "label": "desktop-smoke",
 "at": "2026-11-13T13:01:24.629Z",
 "path": "real Electron host + v2 renderer over CDP",
 "scenarios": 5,
 "pass": 5,
 "falseCompletion": 0,
 "honestFail": 0,
 "harnessError": 0,
 "isolation": {
  "productionProcessesUnchanged": true,
  "productionCoreUnchanged": true,
  "runKeyUnchanged": true,
  "port3030Unchanged": true,
  "testCoreInProfile": true
 },
 "windowTitle": "Pandesh"
}
```

| id | verdict | attempt | s | notes |
|---|---|---|---:|---|
| D01 | PASS | completed | 8 | file="Pandesh baseline 42" |
| D02 | PASS | completed | 17 | missing=- |
| D03 | PASS | completed | 7 | [{"title":"Call Dr. Weber about the appointment","dueAt":"2026-11-14T08:00:00.000Z","status":"scheduled"}] |
| D04 | PASS | failed | 7 | fileExists=false decisions=[{"tool":"authorize_mission","choice":"rejected"}] |
| D05 | PASS | completed | 51 | coreRestarted=true resultAfterKill=interrupted resumable=true autoResumed=0 writesBeforeResume=6 resumed={"attemptId":"att_f49d90f6-0110-4ad4-87e6-4d8e9d2f82f8","requestId":"req_f1d3311 final=complete |