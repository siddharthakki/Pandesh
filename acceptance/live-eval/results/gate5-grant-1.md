# Standing write permission gate5-grant-1 (ff9df4d)

All days as expected: **true**; ordinary client grant -> HTTP 403; cards on granted days: 0

| day | ok | detail |
|---|---|---|
| 1 | ok | A: writes file="2026-11-14" source=standing_grant:rgrant_1a90241c-1267-486d-a336-35daf9ee3a72 uses=1 verified=true ; B: writes file="3" source=standing_grant:rgrant_174b4568-73b6-4715-9dd3-20fdcd627356 uses=1 verified=true |
| 2 | ok | A: writes file="2026-11-14" source=standing_grant:rgrant_1a90241c-1267-486d-a336-35daf9ee3a72 uses=1 verified=true ; B: writes file="4" source=standing_grant:rgrant_174b4568-73b6-4715-9dd3-20fdcd627356 uses=1 verified=true |
| 3 | ok | A: asks file="" result=failed source=host:jarvis notified=1 notApplied=false ; B: writes file="5" source=standing_grant:rgrant_174b4568-73b6-4715-9dd3-20fdcd627356 uses=1 verified=true |
| 4 | ok | A: asks file="" result=failed source=host:jarvis notified=1 notApplied=false ; B: asks file="" result=failed source=host:jarvis notified=1 notApplied=true |
| 5 | ok | A: writes file="2026-11-14" source=standing_grant:rgrant_ea5acdd2-9e13-4a0b-a5e3-f1e8f317efae uses=1 verified=true ; B: asks file="" result=failed source=host:jarvis notified=1 notApplied=true |