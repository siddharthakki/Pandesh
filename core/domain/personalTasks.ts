/**
 * Personal tasks: the to-do items kept inside Pandesh's Projects workspace.
 *
 * Tasks have always lived in `projects.productContext.tasks` (the Projects UI reads them there), but only as
 * `{ id, title, status }`. Build 163's micro-tests TSK-001..025 showed what that cost: "add a deadline", "mark it done",
 * "which tasks are overdue", "what did we complete this week", "what is blocking the invoice task" all failed or were
 * answered with invented updates, because nothing could hold a due date, a priority, a completion time, a blocker or a
 * history, and no tool could change a task.
 *
 * This module keeps the same storage (no migration, the UI keeps working) and makes the task record complete:
 * dueAt, priority (declared by the user only), goal, blockedBy, notes, createdAt/updatedAt/completedAt and an
 * append-only history of every change with its source. Every write goes through `updateProject`, so the project's
 * revision moves and the change is atomic.
 */
import type { CoreDatabase } from '../db/connection';
import type { ProjectRecord } from '../shared/wireTypes';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { createProject, getProject, listProjects, updateProject } from './projects';

export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type TaskPriority = 'high' | 'normal' | 'low';
export const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'blocked', 'done', 'cancelled'];
export const TASK_PRIORITIES: readonly TaskPriority[] = ['high', 'normal', 'low'];

export interface TaskHistoryEntry { at: string; change: string; source: string }

export interface PersonalTask {
  id: string;
  title: string;
  status: TaskStatus;
  dueAt?: string | null;
  /** Only what the user declared. Never inferred from how often a topic comes up. */
  priority?: TaskPriority | null;
  goal?: string | null;
  blockedBy?: string | null;
  notes?: Array<{ at: string; text: string }>;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  history?: TaskHistoryEntry[];
}

export interface TaskView extends PersonalTask {
  projectId: string;
  projectName: string;
  /** Stable reference across projects: `<projectId>/<taskId>`. */
  ref: string;
}

const MAX_TASKS_PER_PROJECT = 500;
const MAX_HISTORY = 50;

function tasksOf(project: ProjectRecord): PersonalTask[] {
  const raw = (project.productContext as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is PersonalTask => Boolean(t) && typeof t === 'object' && typeof (t as PersonalTask).title === 'string').map((t) => ({
    ...t,
    id: String(t.id ?? ''),
    status: (TASK_STATUSES as readonly string[]).includes(String(t.status)) ? t.status : 'pending',
  }));
}

function view(project: ProjectRecord, task: PersonalTask): TaskView {
  return { ...task, projectId: project.id, projectName: project.name, ref: `${project.id}/${task.id}` };
}

/** Every task of every non-archived project (or of all projects with includeArchived). */
export function allTasks(db: CoreDatabase, opts: { includeArchived?: boolean } = {}): TaskView[] {
  const out: TaskView[] = [];
  for (const p of listProjects(db, { limit: 200 })) {
    if (!opts.includeArchived && p.status === 'archived') continue;
    for (const t of tasksOf(p)) out.push(view(p, t));
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** A project by id, exact name or alias (case-insensitive), else a unique partial name match. */
export function findProject(db: CoreDatabase, ref: string): ProjectRecord | null {
  const r = ref.trim();
  if (!r) return null;
  const projects = listProjects(db, { limit: 200 }).filter((p) => p.status !== 'archived');
  const byId = projects.find((p) => p.id === r);
  if (byId) return byId;
  const n = norm(r).replace(/\bproject\b/g, '').trim();
  const exact = projects.filter((p) => norm(p.name) === n || p.aliases.some((a) => norm(a) === n));
  if (exact.length === 1) return exact[0];
  const partial = projects.filter((p) => norm(p.name).includes(n) || n.includes(norm(p.name)));
  return partial.length === 1 ? partial[0] : null;
}

export type TaskMatch = { status: 'found'; task: TaskView } | { status: 'ambiguous'; candidates: TaskView[] } | { status: 'none' };

/**
 * Finds a task by its ref (`proj/task`), id, or words of its title or notes ("the insurance task", "the task where we
 * discussed the monitor"). More than one equally good match is reported as ambiguous, never silently picked.
 */
export function findTask(db: CoreDatabase, ref: string, opts: { includeDone?: boolean } = {}): TaskMatch {
  const tasks = allTasks(db);
  const r = ref.trim();
  if (!r) return { status: 'none' };
  const direct = tasks.filter((t) => t.ref === r || t.id === r);
  if (direct.length === 1) return { status: 'found', task: direct[0] };
  const stop = new Set(['the', 'task', 'tasks', 'my', 'that', 'this', 'where', 'we', 'discussed', 'about', 'with', 'for', 'and', 'to', 'a', 'an', 'of', 'in', 'on', 'existing', 'completed', 'open']);
  const words = norm(r).split(' ').filter((w) => w.length > 1 && !stop.has(w));
  if (!words.length) return { status: 'none' };
  const pool = opts.includeDone === false ? tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled') : tasks;
  const scored = pool.map((t) => {
    const hay = norm(`${t.title} ${(t.notes ?? []).map((n) => n.text).join(' ')} ${t.projectName}`);
    const title = norm(t.title);
    if (title === words.join(' ')) return { t, s: 100 };
    const s = words.filter((w) => hay.includes(w) || (w.length > 4 && hay.includes(w.slice(0, -1)))).length;
    return { t, s };
  }).filter((x) => x.s > 0);
  if (!scored.length) return { status: 'none' };
  const best = Math.max(...scored.map((x) => x.s));
  const top = scored.filter((x) => x.s === best).map((x) => x.t);
  return top.length === 1 ? { status: 'found', task: top[0] } : { status: 'ambiguous', candidates: top.slice(0, 6) };
}

function writeTasks(db: CoreDatabase, project: ProjectRecord, tasks: PersonalTask[]): ProjectRecord {
  if (tasks.length > MAX_TASKS_PER_PROJECT) throw new CoreError('invalid_request', `a project holds at most ${MAX_TASKS_PER_PROJECT} tasks`);
  const ctx = { ...(project.productContext ?? {}), tasks };
  return updateProject(db, project.id, { productContext: ctx, expectedRevision: project.revision });
}

function pushHistory(task: PersonalTask, change: string, source: string, at: string): void {
  task.history = [...(task.history ?? []), { at, change, source }].slice(-MAX_HISTORY);
  task.updatedAt = at;
}

function validDate(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:00` : s);
  if (Number.isNaN(d.getTime())) throw new CoreError('invalid_request', `'${s}' is not a date Core can store; resolve it to an ISO date first (resolve_time)`);
  return d.toISOString();
}

export interface AddTaskInput {
  project: string;
  title: string;
  dueAt?: string | null;
  priority?: TaskPriority | null;
  goal?: string | null;
  blockedBy?: string | null;
  note?: string | null;
  /** Create the project when it does not exist (only when the user named a new one). */
  createProjectIfMissing?: boolean;
  source: string;
}

export function addTask(db: CoreDatabase, input: AddTaskInput): TaskView {
  const title = String(input.title ?? '').trim().slice(0, 300);
  if (!title) throw new CoreError('invalid_request', 'a task needs a title');
  return db.transaction(() => {
    let project = findProject(db, input.project || 'Inbox');
    if (!project) {
      if (!input.createProjectIfMissing && input.project) throw new CoreError('not_found', `no project named '${input.project}'. Existing projects: ${listProjects(db, {}).filter((p) => p.status !== 'archived').map((p) => p.name).join(', ') || 'none'}`);
      project = createProject(db, { name: input.project?.trim() || 'Inbox', productContext: { tasks: [] } });
    }
    const now = nowIso();
    const priority = input.priority ? requirePriority(input.priority) : null;
    const task: PersonalTask = {
      id: newId('ptask'), title, status: input.blockedBy ? 'blocked' : 'pending',
      dueAt: validDate(input.dueAt), priority, goal: input.goal?.trim() || null, blockedBy: input.blockedBy?.trim() || null,
      notes: input.note ? [{ at: now, text: String(input.note).slice(0, 2000) }] : [],
      createdAt: now, updatedAt: now, completedAt: null, history: [],
    };
    pushHistory(task, 'created', input.source, now);
    const tasks = tasksOf(project);
    // Adding a task that is already there (same title, still open) is not a second task: it completes the existing one with
    // whatever the repeat adds. M0 P01: create_project(tasks=[...]) followed by add_task for the same titles left every task twice
    // (and the copy without dates was the one shown first).
    const twin = tasks.find((t) => t.status !== 'done' && t.status !== 'cancelled' && norm(t.title) === norm(title));
    if (twin) {
      const filled: string[] = [];
      if (task.dueAt && !twin.dueAt) { twin.dueAt = task.dueAt; filled.push('due date'); }
      if (task.priority && !twin.priority) { twin.priority = task.priority; filled.push('priority'); }
      if (task.goal && !twin.goal) { twin.goal = task.goal; filled.push('goal'); }
      if (task.blockedBy && !twin.blockedBy) { twin.blockedBy = task.blockedBy; twin.status = 'blocked'; filled.push('blocked-by'); }
      if (task.notes?.length) twin.notes = [...(twin.notes ?? []), ...task.notes];
      pushHistory(twin, `added again; ${filled.length ? `filled in ${filled.join(', ')}` : 'nothing new'}`, input.source, now);
      return view(writeTasks(db, project, tasks), twin);
    }
    const updated = writeTasks(db, project, [...tasks, task]);
    return view(updated, task);
  });
}

function requirePriority(p: unknown): TaskPriority {
  const v = String(p).toLowerCase();
  if (v === 'urgent' || v === 'important') return 'high';
  if (!(TASK_PRIORITIES as readonly string[]).includes(v)) throw new CoreError('invalid_request', `priority must be one of ${TASK_PRIORITIES.join(', ')}`);
  return v as TaskPriority;
}

export interface UpdateTaskInput {
  ref: string;
  title?: string;
  status?: TaskStatus | 'reopen';
  dueAt?: string | null;
  priority?: TaskPriority | null;
  goal?: string | null;
  blockedBy?: string | null;
  note?: string;
  moveToProject?: string;
  source: string;
}

/** Applies the requested changes to exactly one task; reports what changed. A user ticking off their own task needs no file evidence. */
export function updateTask(db: CoreDatabase, input: UpdateTaskInput): { task: TaskView; changes: string[] } {
  return db.transaction(() => {
    const match = findTask(db, input.ref);
    if (match.status === 'none') throw new CoreError('not_found', `no task matches '${input.ref}'`);
    if (match.status === 'ambiguous') throw new CoreError('conflict', `'${input.ref}' matches ${match.candidates.length} tasks: ${match.candidates.map((t) => `"${t.title}" (${t.projectName}, ref ${t.ref})`).join('; ')}. Ask the user which one.`);
    const found = match.task;
    let project = getProject(db, found.projectId);
    const tasks = tasksOf(project);
    const idx = tasks.findIndex((t) => t.id === found.id);
    if (idx < 0) throw new CoreError('conflict', 'the task changed while it was being updated; try again');
    const task = { ...tasks[idx] };
    const now = nowIso();
    const changes: string[] = [];
    if (input.title !== undefined && input.title.trim() && input.title.trim() !== task.title) { changes.push(`renamed "${task.title}" → "${input.title.trim()}"`); task.title = input.title.trim().slice(0, 300); }
    if (input.status !== undefined) {
      const to: TaskStatus = input.status === 'reopen' ? 'pending' : input.status;
      if (!(TASK_STATUSES as readonly string[]).includes(to)) throw new CoreError('invalid_request', `status must be one of ${TASK_STATUSES.join(', ')} or reopen`);
      if (to !== task.status) {
        changes.push(`status ${task.status} → ${to}`);
        task.status = to;
        task.completedAt = to === 'done' ? now : null;
        if (to !== 'blocked' && input.blockedBy === undefined && task.blockedBy && (to === 'done' || to === 'in_progress')) task.blockedBy = null;
      }
    }
    if (input.dueAt !== undefined) { const d = validDate(input.dueAt); if (d !== (task.dueAt ?? null)) { changes.push(`due ${task.dueAt ?? 'none'} → ${d ?? 'none'}`); task.dueAt = d; } }
    if (input.priority !== undefined) { const p = input.priority === null ? null : requirePriority(input.priority); if (p !== (task.priority ?? null)) { changes.push(`priority ${task.priority ?? 'none'} → ${p ?? 'none'}`); task.priority = p; } }
    if (input.goal !== undefined) { const g = input.goal?.trim() || null; if (g !== (task.goal ?? null)) { changes.push(`goal → ${g ?? 'none'}`); task.goal = g; } }
    if (input.blockedBy !== undefined) {
      const b = input.blockedBy?.trim() || null;
      if (b !== (task.blockedBy ?? null)) { changes.push(`blocked by ${b ?? 'nothing'}`); task.blockedBy = b; if (b && task.status === 'pending') task.status = 'blocked'; if (!b && task.status === 'blocked') task.status = 'pending'; }
    }
    if (input.note?.trim()) { task.notes = [...(task.notes ?? []), { at: now, text: input.note.trim().slice(0, 2000) }]; changes.push('note added'); }
    if (input.moveToProject) {
      const target = findProject(db, input.moveToProject);
      if (!target) throw new CoreError('not_found', `no project named '${input.moveToProject}'. Existing projects: ${listProjects(db, {}).filter((p) => p.status !== 'archived').map((p) => p.name).join(', ')}`);
      if (target.id !== project.id) {
        changes.push(`moved ${project.name} → ${target.name}`);
        pushHistory(task, changes.join('; '), input.source, now);
        writeTasks(db, project, tasks.filter((_, i) => i !== idx));
        const t2 = getProject(db, target.id);
        const moved = { ...task, id: tasks.some((t) => t.id === task.id) && tasksOf(t2).some((t) => t.id === task.id) ? newId('ptask') : task.id };
        const saved = writeTasks(db, t2, [...tasksOf(t2), moved]);
        return { task: view(saved, moved), changes };
      }
    }
    if (!changes.length) return { task: view(project, task), changes };
    pushHistory(task, changes.join('; '), input.source, now);
    tasks[idx] = task;
    project = writeTasks(db, project, tasks);
    return { task: view(project, task), changes };
  });
}

export interface ListTasksFilter {
  /** Tasks due within this many days from now (overdue included). */
  dueWithinDays?: number;
  overdue?: boolean;
  status?: TaskStatus | 'open';
  completedSince?: string;
  project?: string;
  text?: string;
  now?: Date;
}

export function listTasks(db: CoreDatabase, filter: ListTasksFilter = {}): TaskView[] {
  const now = filter.now ?? new Date();
  let tasks = allTasks(db);
  if (filter.project) { const p = findProject(db, filter.project); tasks = p ? tasks.filter((t) => t.projectId === p.id) : []; }
  if (filter.status === 'open') tasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  else if (filter.status) tasks = tasks.filter((t) => t.status === filter.status);
  if (filter.overdue) tasks = tasks.filter((t) => t.dueAt && new Date(t.dueAt) < now && t.status !== 'done' && t.status !== 'cancelled');
  if (filter.dueWithinDays !== undefined) {
    const until = now.getTime() + filter.dueWithinDays * 86_400_000;
    tasks = tasks.filter((t) => t.dueAt && new Date(t.dueAt).getTime() <= until && t.status !== 'done' && t.status !== 'cancelled');
  }
  if (filter.completedSince) tasks = tasks.filter((t) => t.status === 'done' && t.completedAt && t.completedAt >= filter.completedSince!);
  if (filter.text) { const m = findTask(db, filter.text); tasks = m.status === 'found' ? tasks.filter((t) => t.ref === m.task.ref) : m.status === 'ambiguous' ? tasks.filter((t) => m.candidates.some((c) => c.ref === t.ref)) : []; }
  return tasks.sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') || a.title.localeCompare(b.title));
}

export function formatTask(t: TaskView, now = new Date()): string {
  const due = t.dueAt ? `, due ${t.dueAt.slice(0, 10)}${new Date(t.dueAt) < now && t.status !== 'done' && t.status !== 'cancelled' ? ' (OVERDUE)' : ''}` : ', no due date';
  return `"${t.title}" [${t.status}${t.priority ? `, ${t.priority} priority` : ''}${due}${t.blockedBy ? `, blocked by: ${t.blockedBy}` : ''}${t.goal ? `, goal: ${t.goal}` : ''}${t.completedAt ? `, completed ${t.completedAt.slice(0, 16).replace('T', ' ')}` : ''}] in ${t.projectName} (ref ${t.ref})`;
}
