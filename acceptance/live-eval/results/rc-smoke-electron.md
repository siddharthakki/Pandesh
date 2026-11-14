# Desktop path rc-smoke-electron

```json
{
 "label": "rc-smoke-electron",
 "at": "2026-11-14T03:58:40.765Z",
 "path": "real Electron host + v2 renderer over CDP",
 "scenarios": 7,
 "pass": 7,
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
| D01 | PASS | completed | 21 | file="Pandesh baseline 42" |
| D02 | PASS | completed | 18 | missing=- |
| D03 | PASS | completed | 6 | [{"title":"Call Dr. Weber about the appointment","dueAt":"2026-11-15T08:00:00.000Z","status":"scheduled"}] |
| D04 | PASS | failed | 7 | fileExists=false decisions=[{"tool":"authorize_mission","choice":"rejected"}] |
| D05 | PASS | completed | 49 | coreRestarted=true resultAfterKill=interrupted resumable=true autoResumed=0 writesBeforeResume=6 resumed={"attemptId":"att_6be0425f-1726-407c-a296-e18cdbb7d647","requestId":"req_00030a7 final=complete |
| D06 | PASS | delivered | 21 | outbox={"id":"notif_47ec065c-e624-482a-a87e-14c1ac3cd593","status":"delivered","attempts":1,"deliveredVia":"windows_toast","deliveredAt":"2026-11-14T03:58:28.297Z","lastError":null,"title":"Routine \" |
| D07 | PASS | null | 8 | shows={"folder":true,"op":true,"limits":true,"off":true} confirm=true grantedBeforeConfirm=0 granted=true revoked=true grantedBy=host:jarvis |