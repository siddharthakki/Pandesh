# Standing write permission gate4-grant-run2 (f3e1efa)

All days as expected: **false**; ordinary client grant -> HTTP 403; cards on granted days: 0

| day | ok | detail |
|---|---|---|
| 1 | FAIL | A: writes file="2026-11-13" source=standing_grant:rgrant_9534283f-e6e2-4b8b-94a8-295875fd0750 uses=1 verified=true ; B: writes file="" source=null uses=0 verified=false |
| 2 | FAIL | A: writes file="2026-11-13" source=standing_grant:rgrant_9534283f-e6e2-4b8b-94a8-295875fd0750 uses=1 verified=true ; B: writes file="" source=null uses=0 verified=false |
| 3 | FAIL | A: asks file="" result=failed source=host:jarvis notified=1 notApplied=false ; B: writes file="" source=null uses=0 verified=false |
| 4 | ok | A: asks file="" result=failed source=host:jarvis notified=1 notApplied=false ; B: asks file="" result=partial source=null notified=1 notApplied=false |
| 5 | ok | A: writes file="2026-11-13" source=standing_grant:rgrant_08811445-7074-4b01-87f3-210d2e87d8e7 uses=1 verified=true ; B: asks file="" result=partial source=null notified=1 notApplied=false |