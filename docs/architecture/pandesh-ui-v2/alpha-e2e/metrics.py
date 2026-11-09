"""Per-scenario metrics from the alpha Core DB (read-only)."""
import sqlite3, json
db = sqlite3.connect(r'file:D:\PandeshAlpha\profile\core.db?mode=ro', uri=True)
db.row_factory = sqlite3.Row
S = {
    'T1': ['att_950a4029-3723-4bef-b681-a665018742b2'], 'T2': ['att_e034bd76-71db-4949-8512-16a8e9138c61'],
    'T3': ['att_ad33823f-0815-4fcf-95f2-93539df2c917'], 'T4': ['att_7b262b07-5a6e-4152-a688-8dfbcd3a0091'],
    'T6': ['att_135e3d69-3a9d-4cd1-81a2-5986c35e91ed'], 'T7': ['att_2d01fc4f-78f1-4fc1-8bb0-24bbe2bfbe05'],
    'T8': ['att_f8c07e7f-c69d-4551-97f6-28879352c55c'], 'T9': ['att_598e64ac-49e9-4835-821d-99f297dce1a7'],
    'T10': ['att_3c7804f9-0258-4a80-9f47-fd96f9049c8c'], 'T12': ['att_1413bd6a-e80e-435c-9982-cb69b88719b4'],
}
out = {}
for k, ids in S.items():
    m = {'model_calls': 0, 'prompt_tokens': 0, 'output_tokens': 0, 'model_tool_calls': 0, 'first_token_ms': None,
         'tools_recorded': 0, 'tools_ok': 0, 'tools_failed': 0, 'approvals': [], 'status': None, 'duration_s': None, 'handoffs': 0}
    for a in ids:
        r = db.execute('SELECT status, startedAt, completedAt, createdAt FROM attempts WHERE id=?', (a,)).fetchone()
        m['status'] = r['status']
        from datetime import datetime
        f = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00'))
        if r['completedAt']: m['duration_s'] = round((f(r['completedAt']) - f(r['createdAt'])).total_seconds(), 1)
        for e in db.execute("SELECT metadata FROM runtime_events WHERE entityId=? AND eventType='model_call' ORDER BY rowid", (a,)):
            j = json.loads(e['metadata']); m['model_calls'] += 1
            m['prompt_tokens'] += j.get('promptTokens', 0); m['output_tokens'] += j.get('outputTokens', 0); m['model_tool_calls'] += j.get('toolCalls', 0)
            if m['first_token_ms'] is None: m['first_token_ms'] = j.get('firstTokenMs')
        for t in db.execute('SELECT status FROM tool_invocations WHERE attemptId=?', (a,)):
            m['tools_recorded'] += 1; m['tools_ok' if t['status'] == 'succeeded' else 'tools_failed'] += 1
        for p in db.execute('SELECT kind, status, resolution, summary FROM approvals WHERE attemptId=?', (a,)):
            m['approvals'].append((json.loads(p['summary']).get('toolName'), p['resolution'] or p['status']))
        m['handoffs'] += db.execute('SELECT count(*) FROM agent_handoffs WHERE parentAttemptId=?', (a,)).fetchone()[0]
    out[k] = m
print(json.dumps(out, indent=1))
json.dump(out, open(r'D:\PandeshAlpha\evidence\metrics.json', 'w'), indent=1)
