"""Read-only queries against the alpha profile's Core DB (verification only; never writes).
usage: python -I h.py wait <sinceIso> [timeoutSec]   -> waits until the newest attempt since <since> is terminal or waits for approval
       python -I h.py turns <sinceIso>                -> requests, attempts, tool calls with args/evidence
       python -I h.py events <attemptId> [pattern]
       python -I h.py sql "<select ...>"
"""
import sqlite3, sys, time, json
DB = r'file:D:\PandeshAlpha\profile\core.db?mode=ro'

def db():
    c = sqlite3.connect(DB, uri=True, timeout=10)
    c.row_factory = sqlite3.Row
    return c

def latest(since):
    c = db()
    rows = c.execute("""SELECT a.id, a.status, a.createdAt, a.completedAt, q.currentMessage, q.conversationId FROM attempts a JOIN requests q ON q.id=a.requestId
                        WHERE q.createdAt >= ? AND q.conversationId IS NOT NULL ORDER BY a.createdAt""", (since,)).fetchall()
    return rows

cmd = sys.argv[1]
if cmd == 'wait':
    since = sys.argv[2]; limit = float(sys.argv[3]) if len(sys.argv) > 3 else 900
    t0 = time.time()
    while True:
        rows = latest(since)
        active = [r for r in rows if r['status'] not in ('completed', 'failed', 'cancelled')]
        pend = db().execute("SELECT id, substr(summary,1,400) s FROM approvals WHERE status='pending' AND requestedAt >= ?", (since,)).fetchall()
        if rows and not active:
            print('DONE', [(r['id'], r['status']) for r in rows]); break
        if pend:
            print('APPROVAL_PENDING', [(p['id'], p['s']) for p in pend]); break
        if time.time() - t0 > limit:
            print('TIMEOUT', [(r['id'], r['status']) for r in rows]); break
        time.sleep(4)
elif cmd == 'turns':
    c = db()
    for r in latest(sys.argv[2]):
        print('=' * 90)
        print(r['createdAt'], '->', r['completedAt'], r['status'], r['conversationId'], '|', (r['currentMessage'] or '')[:150].replace('\n', ' '))
        print('  attempt', r['id'])
        for t in c.execute("SELECT toolName, status, startedAt, endedAt, exitCode, substr(coalesce(argsSummary,''),1,300) a, substr(coalesce(evidence,''),1,500) e FROM tool_invocations WHERE attemptId=? ORDER BY startedAt", (r['id'],)):
            print('   TOOL', t['toolName'], t['status'], t['startedAt'], 'exit', t['exitCode'], '|', (t['a'] or '').replace('\n', ' '))
            print('      ->', (t['e'] or '').replace('\n', ' ')[:500])
elif cmd == 'events':
    c = db(); pat = sys.argv[3] if len(sys.argv) > 3 else '%'
    for e in c.execute("SELECT createdAt, eventType, substr(coalesce(metadata,''),1,600) m FROM runtime_events WHERE entityId=? AND eventType LIKE ? ORDER BY rowid", (sys.argv[2], pat)):
        print(e['createdAt'], e['eventType'], e['m'].replace('\n', ' '))
elif cmd == 'sql':
    c = db()
    for r in c.execute(sys.argv[2]):
        print(json.dumps(dict(r), default=str)[:1500])
elif cmd == 'reply':
    c = db()
    for m in c.execute("SELECT createdAt, role, content FROM conversation_messages WHERE createdAt >= ? AND role='assistant' ORDER BY seq", (sys.argv[2],)):
        print('---', m['createdAt']); print(m['content'])
elif cmd == 'models':
    c = db()
    cols = [r[1] for r in c.execute("pragma table_info(model_invocations)")]
    print(cols)
