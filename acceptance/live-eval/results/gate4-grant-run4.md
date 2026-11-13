# Standing write permission gate4-grant-run4 (f3e1efa)

All days as expected: **false**; ordinary client grant -> HTTP 403; cards on granted days: 0

| day | ok | detail |
|---|---|---|
| 1 | ok | A: writes file="2026-11-13" source=standing_grant:rgrant_5d9647ca-453a-4604-afdb-0dff42a8cfc3 uses=1 verified=true ; B: writes file="3" source=standing_grant:rgrant_df34e02e-3428-41d7-a7f3-f0ec59171140 uses=1 verified=true |
| 2 | ok | A: writes file="2026-11-13" source=standing_grant:rgrant_5d9647ca-453a-4604-afdb-0dff42a8cfc3 uses=1 verified=true ; B: writes file="4" source=standing_grant:rgrant_df34e02e-3428-41d7-a7f3-f0ec59171140 uses=1 verified=true |
| 3 | ok | A: asks file="" result=failed source=host:jarvis notified=1 notApplied=false ; B: writes file="5" source=standing_grant:rgrant_df34e02e-3428-41d7-a7f3-f0ec59171140 uses=1 verified=true |
| 4 | ok | A: asks file="" result=failed source=host:jarvis notified=1 notApplied=false ; B: asks file="" result=failed source=host:jarvis notified=1 notApplied=true |
| 5 | FAIL | A: writes file="" source=null uses=0 verified=false ; B: asks file="" result=failed source=host:jarvis notified=1 notApplied=true |