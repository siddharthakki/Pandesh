# Desktop path b170-installed-realworld2

```json
{
 "label": "b170-installed-realworld2",
 "at": "2026-11-14T05:40:39.545Z",
 "path": "real Electron host + v2 renderer over CDP",
 "scenarios": 4,
 "pass": 3,
 "falseCompletion": 1,
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
| R01 | PASS | completed | 7 | tools=list_directory,read_file |
| R02 | FALSE_COMPLETION | completed | 3 | tools= |
| R03 | PASS | completed | 10 | actualGB=600 reply=558.8 |
| R04 | PASS | completed | 8 | quotedRealFirstLine=false |