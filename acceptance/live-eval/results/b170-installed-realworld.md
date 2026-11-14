# Desktop path b170-installed-realworld

```json
{
 "label": "b170-installed-realworld",
 "at": "2026-11-14T05:39:33.370Z",
 "path": "real Electron host + v2 renderer over CDP",
 "scenarios": 11,
 "pass": 8,
 "falseCompletion": 0,
 "honestFail": 2,
 "harnessError": 1,
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
| D01 | PASS | completed | 27 | file="Pandesh baseline 42" |
| D02 | PASS | completed | 15 | missing=- |
| D03 | PASS | completed | 6 | [{"title":"Call Dr. Weber about the appointment","dueAt":"2026-11-15T08:00:00.000Z","status":"scheduled"}] |
| D04 | PASS | failed | 7 | fileExists=false decisions=[{"tool":"authorize_mission","choice":"rejected"}] |
| D05 | PASS | completed | 51 | coreRestarted=true resultAfterKill=interrupted resumable=true autoResumed=0 writesBeforeResume=6 resumed={"attemptId":"att_9a33c11d-722d-4971-8b24-39eb3214e9ec","requestId":"req_36df5ea final=complete |
| D06 | PASS | delivered | 21 | outbox={"id":"notif_518124bd-5abe-4368-95b6-586011c49c09","status":"delivered","attempts":1,"deliveredVia":"windows_toast","deliveredAt":"2026-11-14T05:18:15.531Z","lastError":null,"title":"Routine \" |
| D07 | PASS | null | 8 | shows={"folder":true,"op":true,"limits":true,"off":true} confirm=true grantedBeforeConfirm=0 granted=true revoked=true grantedBy=host:jarvis |
| R01 | HONEST_FAIL | failed | 422 | tools=list_directory,update_task_outcome,write_file,write_file,write_file,write_file,write_file,write_file |
| R02 | HONEST_FAIL | failed | 421 | tools=list_directory,update_task_outcome,write_file,write_file,write_file,write_file,write_file,write_file |
| R03 | PASS | failed | 422 | actualGB=600 reply=558.8 |
| R04 | ERROR | null | 0 | HARNESS ERROR ENOENT: no such file or directory, open 'C:Windowswin.ini' |