# Standing write permission rc-smoke-routines-2 (b2aa041)

All days as expected: **true**; ordinary client grant -> HTTP 403; cards on granted days: 0

| day | ok | detail |
|---|---|---|
| 1 | ok | A: writes file="2026-11-14" source=standing_grant:rgrant_19918cec-ac13-4573-8dde-0faea2bcd3f7 uses=1 verified=true ; B: writes file="3" source=standing_grant:rgrant_3ce372e2-3933-42b1-8b63-22166c440962 uses=1 verified=true |
| 2 | ok | A: writes file="2026-11-14" source=standing_grant:rgrant_19918cec-ac13-4573-8dde-0faea2bcd3f7 uses=1 verified=true ; B: writes file="4" source=standing_grant:rgrant_3ce372e2-3933-42b1-8b63-22166c440962 uses=1 verified=true |
| 3 | ok | A: asks file="" result=failed source=host:jarvis notified=1 notApplied=false ; B: writes file="5" source=standing_grant:rgrant_3ce372e2-3933-42b1-8b63-22166c440962 uses=1 verified=true |
| 4 | ok | A: asks file="" result=failed source=host:jarvis notified=1 notApplied=false ; B: asks file="" result=failed source=host:jarvis notified=1 notApplied=true |
| 5 | ok | A: writes file="2026-11-14" source=standing_grant:rgrant_d13d43ac-e76c-4971-8846-18e23367cd3f uses=1 verified=true ; B: asks file="" result=failed source=host:jarvis notified=1 notApplied=true |