# Standing write permission gate4-grant-run1 (f3e1efa)

All days as expected: **false**; ordinary client grant -> HTTP 403; cards on granted days: 0

| day | ok | detail |
|---|---|---|
| 1 | ok | A: writes file="2026-11-13" source=standing_grant:rgrant_811e6ca0-ec9a-42a0-b190-4954c42c32ab uses=1 verified=true ; B: writes file="3" source=standing_grant:rgrant_4d95d6f9-4069-43af-be4e-4a5ca6f45f7a uses=1 verified=true |
| 2 | ok | A: writes file="2026-11-13" source=standing_grant:rgrant_811e6ca0-ec9a-42a0-b190-4954c42c32ab uses=1 verified=true ; B: writes file="4" source=standing_grant:rgrant_4d95d6f9-4069-43af-be4e-4a5ca6f45f7a uses=1 verified=true |
| 3 | ok | A: asks file="" result=failed source=host:jarvis notified=1 notApplied=false ; B: writes file="5" source=standing_grant:rgrant_4d95d6f9-4069-43af-be4e-4a5ca6f45f7a uses=1 verified=true |
| 4 | ok | A: asks file="" result=partial source=null notified=1 notApplied=false ; B: asks file="" result=failed source=host:jarvis notified=1 notApplied=true |
| 5 | FAIL | A: writes file="" source=null uses=0 verified=false ; B: asks file="" result=failed source=host:jarvis notified=1 notApplied=true |