# Standing write permission gate4-grant-run6 (f3e1efa)

All days as expected: **false**; ordinary client grant -> HTTP 403; cards on granted days: 0

| day | ok | detail |
|---|---|---|
| 1 | FAIL | A: writes file="2026-11-13" source=standing_grant:rgrant_0f0c9886-5aac-4570-9bae-f9747ede5b67 uses=1 verified=true ; B: writes file="" source=null uses=0 verified=false |
| 2 | FAIL | A: writes file="2026-11-13" source=standing_grant:rgrant_0f0c9886-5aac-4570-9bae-f9747ede5b67 uses=1 verified=true ; B: writes file="" source=null uses=0 verified=false |
| 3 | FAIL | A: asks file="" result=failed source=host:jarvis notified=1 notApplied=false ; B: writes file="" source=null uses=0 verified=false |
| 4 | ok | A: asks file="" result=failed source=host:jarvis notified=1 notApplied=false ; B: asks file="" result=partial source=null notified=1 notApplied=false |
| 5 | ok | A: writes file="2026-11-13" source=standing_grant:rgrant_0fe1e820-76c6-47e4-8085-8a5160627287 uses=1 verified=true ; B: asks file="" result=partial source=null notified=1 notApplied=false |