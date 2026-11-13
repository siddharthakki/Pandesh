# Standing write permission gate4-grant-run5 (f3e1efa)

All days as expected: **false**; ordinary client grant -> HTTP 403; cards on granted days: 0

| day | ok | detail |
|---|---|---|
| 1 | FAIL | A: writes file="2026-11-13" source=standing_grant:rgrant_6d8135b3-54af-43cf-abf6-a24db13bf9b8 uses=1 verified=true ; B: writes file="" source=null uses=0 verified=false |
| 2 | FAIL | A: writes file="2026-11-13" source=standing_grant:rgrant_6d8135b3-54af-43cf-abf6-a24db13bf9b8 uses=1 verified=true ; B: writes file="" source=null uses=0 verified=false |
| 3 | ok | A: asks file="" result=failed source=host:jarvis notified=1 notApplied=false ; B: writes file="5" source=standing_grant:rgrant_ade258ea-77cb-49a3-b50c-492d0635fc11 uses=1 verified=true |
| 4 | ok | A: asks file="" result=failed source=host:jarvis notified=1 notApplied=false ; B: asks file="" result=failed source=host:jarvis notified=1 notApplied=true |
| 5 | ok | A: writes file="2026-11-13" source=standing_grant:rgrant_61f1aa3f-3916-42c3-bf2d-e2e65a0d6ecf uses=1 verified=true ; B: asks file="" result=failed source=host:jarvis notified=1 notApplied=true |