# Standing write permission gate4-grant-run7 (f3e1efa)

All days as expected: **false**; ordinary client grant -> HTTP 403; cards on granted days: 0

| day | ok | detail |
|---|---|---|
| 1 | FAIL | A: writes file="2026-11-13" source=standing_grant:rgrant_b0550d35-02d5-49da-b703-faf75a2c6051 uses=1 verified=true ; B: writes file="0" source=standing_grant:rgrant_38d985fc-95fd-45fa-b88c-9e81632debf9 uses=1 verified=true |
| 2 | ok | A: writes file="2026-11-13" source=standing_grant:rgrant_b0550d35-02d5-49da-b703-faf75a2c6051 uses=1 verified=true ; B: writes file="4" source=standing_grant:rgrant_38d985fc-95fd-45fa-b88c-9e81632debf9 uses=1 verified=true |
| 3 | ok | A: asks file="" result=failed source=host:jarvis notified=1 notApplied=false ; B: writes file="5" source=standing_grant:rgrant_38d985fc-95fd-45fa-b88c-9e81632debf9 uses=1 verified=true |
| 4 | ok | A: asks file="" result=failed source=host:jarvis notified=1 notApplied=false ; B: asks file="" result=failed source=host:jarvis notified=1 notApplied=true |
| 5 | ok | A: writes file="2026-11-13" source=standing_grant:rgrant_88bf43e2-f986-4107-a308-b66acec9d3a5 uses=1 verified=true ; B: asks file="" result=failed source=host:jarvis notified=1 notApplied=true |