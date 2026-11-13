import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase, type CoreDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { createConversation, appendMessage } from '../domain/conversations';
import { createProject } from '../domain/projects';
import { rememberMemory, recallMemories } from '../domain/memory';
import { addTask, updateTask, findTask, listTasks } from '../domain/personalTasks';
import { buildPersonalContextSection, collectPersonalState, factSourceClass, personalOverview, rankPriorities } from '../domain/personalContext';
import { searchBrain, searchBrainForChat, documentSensitivity } from '../domain/secondBrain';
import { extractRefs } from '../domain/toolJournal';
import { isPublicResearchTask } from '../runtime/piAgentEngine';
import { classifyStatusRequest } from '../runtime/assistantStatus';

let dir: string; let db: CoreDatabase;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pctx-')); db = openDatabase(path.join(dir, 'core.db')); runMigrations(db); });
afterEach(() => { try { db.close(); } catch { /* */ } fs.rmSync(dir, { recursive: true, force: true }); });

function fact(subject: string, predicate: string, value: string) {
  const c = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 't' });
  const m = appendMessage(db, c.id, { role: 'user', content: `${subject} ${value}`, actor: 'user' });
  return rememberMemory(db, { memoryType: 'user', scopeType: 'user', scopeId: 'user_profile', subject, predicate, value, sensitivity: 'internal', sourceConversationId: c.id, sourceMessageId: m.id, actor: 'user' }).memory.id;
}
const iso = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

describe('personal tasks', () => {
  it('adds, dates, blocks, completes and reopens a task with a history; a done task needs no file evidence', () => {
    const t = addTask(db, { project: 'Inbox', title: 'Review insurance letter', createProjectIfMissing: true, source: 'test' });
    expect(t.ref).toMatch(/^proj_.+\/ptask_/);
    updateTask(db, { ref: 'insurance letter', dueAt: '2026-11-13', source: 'test' });
    updateTask(db, { ref: t.id, blockedBy: 'policy number', source: 'test' });
    expect(findTask(db, 'insurance').status).toBe('found');
    const done = updateTask(db, { ref: t.ref, status: 'done', source: 'test' }).task;
    expect(done.status).toBe('done'); expect(done.completedAt).toBeTruthy(); expect(done.blockedBy).toBeNull();
    const re = updateTask(db, { ref: t.ref, status: 'reopen', source: 'test' }).task;
    expect(re.status).toBe('pending'); expect(re.completedAt).toBeNull();
    expect(re.history!.map((h) => h.change).join(' | ')).toMatch(/created.*due.*blocked by policy number.*done.*pending/);
  });
  it('reports two equally good matches as ambiguous instead of picking one', () => {
    createProject(db, { name: 'Home', productContext: { tasks: [{ id: 'a', title: 'Pay electricity bill', status: 'pending' }, { id: 'b', title: 'Pay water bill', status: 'pending' }] } });
    const m = findTask(db, 'the bill task');
    expect(m.status).toBe('ambiguous');
    expect(() => updateTask(db, { ref: 'bill', status: 'done', source: 't' })).toThrow(/matches 2 tasks/);
  });
  it('moves a task between projects and refuses an unknown project', () => {
    createProject(db, { name: 'Home', productContext: { tasks: [] } });
    const t = addTask(db, { project: 'Inbox', title: 'Buy rice', createProjectIfMissing: true, source: 't' });
    expect(updateTask(db, { ref: t.ref, moveToProject: 'home project', source: 't' }).task.projectName).toBe('Home');
    expect(() => addTask(db, { project: 'Nowhere', title: 'x', source: 't' })).toThrow(/no project named 'Nowhere'/);
  });
  it('filters overdue and due-soon; undated tasks are never overdue', () => {
    addTask(db, { project: 'Inbox', title: 'late', dueAt: iso(-2), createProjectIfMissing: true, source: 't' });
    addTask(db, { project: 'Inbox', title: 'soon', dueAt: iso(2), source: 't' });
    addTask(db, { project: 'Inbox', title: 'someday', source: 't' });
    expect(listTasks(db, { overdue: true }).map((t) => t.title)).toEqual(['late']);
    expect(listTasks(db, { dueWithinDays: 7 }).map((t) => t.title)).toEqual(['late', 'soon']);
    expect(() => addTask(db, { project: 'Inbox', title: 'bad', dueAt: 'next Friday', source: 't' })).toThrow(/resolve_time/);
  });
});

describe('personal context', () => {
  it('labels a fact the user stated, and never shows an unevidenced one as confirmed', () => {
    const id = fact('home', 'lives in', 'Ulm');
    expect(factSourceClass(db, { id, predicate: 'lives in', consentApprovalId: null, memoryType: 'user' })).toBe('user_stated');
    expect(factSourceClass(db, { id: 'mem_none', predicate: 'lives in', consentApprovalId: null, memoryType: 'user' })).toBe('inferred');
    expect(factSourceClass(db, { id, predicate: 'inferred preference', consentApprovalId: null, memoryType: 'user' })).toBe('inferred');
  });
  it('ranks by deadline, declared priority and stated goals — not by how often a topic was mentioned', () => {
    fact('career', 'goal', 'Get a data engineering job — top priority');
    addTask(db, { project: 'Inbox', title: 'Practice SQL interview questions', goal: 'data engineering job', dueAt: iso(4), createProjectIfMissing: true, source: 't' });
    addTask(db, { project: 'Inbox', title: 'Clean the garage', dueAt: iso(4), source: 't' });
    for (let i = 0; i < 20; i++) fact(`garage note ${i}`, 'note', `garage garage garage ${i}`);
    const ranked = rankPriorities(collectPersonalState(db));
    expect(ranked[0].item.title).toBe('Practice SQL interview questions');
    expect(ranked[0].reasons.join(' ')).toMatch(/goal/);
  });
  it('gates the turn section: nothing for small talk or specialists; a withheld notice for a non-local model', () => {
    fact('home', 'lives in', 'Ulm');
    addTask(db, { project: 'Inbox', title: 'Pay rent', dueAt: iso(1), createProjectIfMissing: true, source: 't' });
    expect(buildPersonalContextSection(db, { message: 'What is 17 times 23?', localModel: true }).section).toBe('');
    expect(buildPersonalContextSection(db, { message: 'what is due this week for me?', agentId: 'research', localModel: true }).section).toBe('');
    const cloud = buildPersonalContextSection(db, { message: 'what is due this week for me?', localModel: false });
    expect(cloud.withheld).toBe(true); expect(cloud.section).not.toMatch(/Ulm|rent/i);
    const local = buildPersonalContextSection(db, { message: 'what is due this week for me?', localModel: true });
    expect(local.section).toMatch(/Pay rent/); expect(local.chars).toBeLessThanOrEqual(1800);
  });
  it('overview says plainly when nothing is recorded', () => {
    const o = personalOverview(db, { focus: 'all' });
    expect(o).toMatch(/nothing is remembered about you yet/);
    expect(o).toMatch(/not recorded in Core: say so instead of guessing/);
  });
  it('recall retries a guessed subject/predicate as free words (micro-test MEM-012)', () => {
    fact('model', 'prefers', 'gemma4:12b for quick questions');
    expect(recallMemories(db, { predicate: 'model preference' }).entries.map((e) => e.memory.displayValue)).toEqual(['gemma4:12b for quick questions']);
  });
});

describe('second brain retrieval', () => {
  it('falls back to any-word matching for a paraphrase, cites the file, and never indexes a secret-named file', () => {
    const folder = path.join(dir, 'notes'); fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'datacorp-posting.md'), '# DataCorp\nApplication deadline: 28 November 2026');
    fs.writeFileSync(path.join(folder, 'my-passwords.txt'), 'deadline password hunter2');
    db.run("INSERT INTO document_read_grants (id, folder, grantedAt, grantedBy) VALUES ('g1', ?, ?, 'user')", [folder, new Date().toISOString()]);
    expect(searchBrain(db, { q: 'when must I send my application' }).total).toBe(0);
    const out = searchBrainForChat(db, { q: 'when must I send my application', localModel: true });
    expect(out.mode).toBe('any_word'); expect(out.text).toMatch(/datacorp-posting\.md › DataCorp/); expect(out.text).toMatch(/28 November/);
    expect(out.text).not.toMatch(/hunter2/);
    expect(searchBrainForChat(db, { q: 'deadline', localModel: false }).text).toMatch(/content withheld/);
    expect(documentSensitivity('C:/x/bank-statement.md')).toBe('restricted');
    expect(documentSensitivity('C:/x/spinach-recipes.md')).toBe('internal');
  });
});

describe('routing and journal fixes', () => {
  it('a question about an earlier posting is not a public job search; a vacancy search still is', () => {
    expect(isPublicResearchTask('What were the salary and the link of that job posting?')).toBe(false);
    expect(isPublicResearchTask('What did the posting you read say about the salary?')).toBe(false);
    expect(isPublicResearchTask('Find data engineer jobs in Ulm with salary')).toBe(true);
  });
  it("the user's own tasks do not go to the background-work status shortcut", () => {
    expect(classifyStatusRequest('What tasks do I have due this week?')).toBeNull();
    expect(classifyStatusRequest('Which of my tasks are pending?')).toBeNull();
    expect(classifyStatusRequest('What tasks are you running?')).toEqual(['tasks']);
  });
  it('a declared primary id is the created item, not the first id in the result text', () => {
    const refs = extractRefs({ toolName: 'add_task', args: { title: 'Book kitchen' }, resultText: 'Added task in proj_11111111-1111-4111-8111-111111111111/ptask_22222222-2222-4222-8222-222222222222', details: { primaryId: 'ptask_22222222-2222-4222-8222-222222222222' }, effect: 'created', status: 'succeeded' });
    expect(refs.find((r) => r.role === 'created')?.id).toBe('ptask_22222222-2222-4222-8222-222222222222');
  });
});

describe('adding the same task twice (M0 P01)', () => {
  it('completes the existing task instead of creating a second one, and a done task can be added again', () => {
    const first = addTask(db, { project: 'Shed', title: 'Buy wood', createProjectIfMissing: true, source: 'test' });
    const again = addTask(db, { project: 'Shed', title: ' buy WOOD ', dueAt: '2026-12-01', priority: 'high', source: 'test' });
    expect(again.id).toBe(first.id);
    expect(again.dueAt?.slice(0, 10)).toBe('2026-12-01'); expect(again.priority).toBe('high');
    expect(listTasks(db, {}).filter((t) => /wood/i.test(t.title))).toHaveLength(1);
    updateTask(db, { ref: first.ref, status: 'done', source: 'test' });
    expect(addTask(db, { project: 'Shed', title: 'Buy wood', source: 'test' }).id).not.toBe(first.id);
  });
});
