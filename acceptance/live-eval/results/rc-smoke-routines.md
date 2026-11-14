# Standing write permission rc-smoke-routines (a3a23d6)

All days as expected: **false**; ordinary client grant -> HTTP 403; cards on granted days: 0

| day | ok | detail |
|---|---|---|
| 1 | FAIL | A: writes file="2026-11-14" source=standing_grant:rgrant_0c1db57a-e531-4cf9-88db-f2b00f247d73 uses=1 verified=true ; B: writes file="3" source=standing_grant:rgrant_5bfdde39-34fb-404e-8ad6-6ef20e1eb666 uses=1 verified=false |
| 2 | FAIL | A: writes file="2026-11-14" source=standing_grant:rgrant_0c1db57a-e531-4cf9-88db-f2b00f247d73 uses=1 verified=true ; B: writes file="4" source=standing_grant:rgrant_5bfdde39-34fb-404e-8ad6-6ef20e1eb666 uses=1 verified=false |
| 3 | FAIL | A: asks file="" result=failed source=host:jarvis notified=1 notApplied=false ; B: writes file="5" source=standing_grant:rgrant_5bfdde39-34fb-404e-8ad6-6ef20e1eb666 uses=1 verified=false |
| 4 | ok | A: asks file="" result=failed source=host:jarvis notified=1 notApplied=false ; B: asks file="" result=failed source=host:jarvis notified=1 notApplied=true |
| 5 | ok | A: writes file="2026-11-14" source=standing_grant:rgrant_7bd2ecb1-ad97-4aac-b911-57dada9baea9 uses=1 verified=true ; B: asks file="" result=failed source=host:jarvis notified=1 notApplied=true |