# Standing write permission gate4-grant-run3 (f3e1efa)

All days as expected: **false**; ordinary client grant -> HTTP 403; cards on granted days: 0

| day | ok | detail |
|---|---|---|
| 1 | ok | A: writes file="2026-11-13" source=standing_grant:rgrant_b1754069-bad6-4bbc-b4fd-b0fc52e9786d uses=1 verified=true ; B: writes file="3" source=standing_grant:rgrant_0722ded9-1605-4e0c-8621-f865a8911b54 uses=1 verified=true |
| 2 | ok | A: writes file="2026-11-13" source=standing_grant:rgrant_b1754069-bad6-4bbc-b4fd-b0fc52e9786d uses=1 verified=true ; B: writes file="4" source=standing_grant:rgrant_0722ded9-1605-4e0c-8621-f865a8911b54 uses=1 verified=true |
| 3 | ok | A: asks file="" result=failed source=host:jarvis notified=1 notApplied=false ; B: writes file="5" source=standing_grant:rgrant_0722ded9-1605-4e0c-8621-f865a8911b54 uses=1 verified=true |
| 4 | ok | A: asks file="" result=failed source=host:jarvis notified=1 notApplied=false ; B: asks file="" result=failed source=host:jarvis notified=1 notApplied=true |
| 5 | FAIL | A: writes file="" source=null uses=0 verified=false ; B: asks file="" result=partial source=null notified=1 notApplied=false |