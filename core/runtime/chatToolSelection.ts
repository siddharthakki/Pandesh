/**
 * Task-aware tool selection for the chat engine.
 *
 * Every request used to carry all ~79 tool definitions (~52K characters, ~12K tokens) before any history. With the
 * system prompt that was ~17.4K prompt tokens for "what is 17 times 23", 6-7 s of prompt processing on the first call
 * of a turn, and a long conversation ran out of the 32K window (D15). The model also had to choose among tools that
 * had nothing to do with the request.
 *
 * Selection is deterministic and conservative:
 *  - BASE tools (time, arithmetic, the selected folder, the task record and request_tools) are always offered;
 *  - a group is offered when the request, the previous user message, or a tool used in the last few turns of this
 *    conversation points at it (recall over precision: an extra group costs size, a missing one costs the task);
 *  - a tool this module does not know is always offered, so a new tool never silently disappears;
 *  - everything else stays executable and can be added during the turn with request_tools.
 * Governance is unchanged: the hidden tools are the same objects, with the same approvals, Plan Only wrapping and
 * receipts, offered later.
 */

export interface ToolGroup {
  /** One line for the request_tools description. */
  purpose: string;
  /** Request wording that points at the group. */
  pattern: RegExp;
}

export const TOOL_GROUPS: Record<string, ToolGroup> = {
  files_more: {
    purpose: 'projects and repositories, other folders and drives, duplicate files, permission to search outside the selected folder',
    pattern: /\b(?:projects?|repos?|repositor(?:y|ies)|drives?|duplicates?|across (?:my|the)|outside|other folders?|whole (?:pc|computer|disk)|search (?:my|the) (?:pc|computer|disk|drive))\b|\b[a-z]:\\/i,
  },
  pc: {
    purpose: 'this PC: disks and free space, hardware and GPU, processes, services and listening ports, screen and windows, installed software and where an app is, available software updates and what Pandesh can do',
    // Locating an app: "find/where … app|program" (not "write a program"), and a short "where is X?" question.
    pattern: /\b(?:pc|computer|machine|laptop|hardware|specs?|disks?|drives?|free space|storage|ram|cpu|gpu|vram|nvidia|processes?|services?|ports?|screen(?:shot)?|desktop|windows? (?:list|open)|installed|install|software|utilit(?:y|ies)|setup|diagnos\w*|capabilit(?:y|ies)|what can you do|which tools|updates?|outdated|upgrades?|versions?|[\w-]+\.exe)\b|\b(?:where|find|locate)\b[^.?!]{0,40}\b(?:apps?|applications?|programs?)\b|^\s*(?:(?:hey|ok|so)[\s,]+)?(?:pandesh[\s,]+)?where(?:'s|\s+is|\s+are)\s+(?:the\s+|my\s+)?[\w.+-]+(?:\s+[\w.+-]+)?\s*[?.!]*\s*$/i,
  },
  projects: {
    purpose: "Pandesh's Projects workspace: create a project with tasks, list saved projects",
    // F13e: "current project tasks" did not offer list_projects, and the model went through the folder running tests.
    pattern: /\b(?:create|new|add|start|set up|make)\b[^.]{0,40}\bprojects?\b|\bprojects?\s+(?:workspace|named|called|with|tasks?|status|list)\b|\b(?:my|saved|list|show|current|open|active|all)\s+projects\b|\bprojects workspace\b|\b(?:current|open|pending)\s+(?:project\s+)?tasks\b/i,
  },
  models: {
    purpose: 'local AI models in Ollama: list, pull, unload, delete',
    pattern: /\b(?:ollama|models?|llms?|gemma\w*|qwen\w*|llama\w*|mistral|deepseek)\b/i,
  },
  documents: {
    purpose: 'documents: read PDFs, Word and spreadsheets, OCR scans, export a PDF report',
    pattern: /\b(?:pdfs?|docx?|word documents?|excel|xlsx|spreadsheets?|invoices?|receipts?|statements?|contracts?|scan(?:s|ned)?|ocr|cv|report|documents?)\b/i,
  },
  images: {
    purpose: 'create or edit images with the local image tools',
    pattern: /\b(?:images?|photos?|pictures?|pics?|artwork|illustrations?|drawings?|draw|render|wallpaper|logo|comfyui)\b/i,
  },
  web: {
    purpose: 'search the public web and official sources, with links',
    pattern: /\b(?:search|web|online|internet|google|look (?:it )?up|latest|current|news|official|sources?|websites?|links?|urls?|jobs?|vacanc\w*|research)\b|https?:\/\//i,
  },
  browser: {
    purpose: 'open a web page in the browser and inspect what it says',
    pattern: /\b(?:browser|browse|web ?pages?|websites?|open (?:the |that |this )?(?:site|page|link|url)s?)\b/i,
  },
  email: {
    purpose: 'Gmail: search, read, draft, send, organize email',
    pattern: /\b(?:e-?mails?|mail|gmail|inbox|drafts?|replies|reply to|newsletters?|attachments?)\b|[\w.+-]+@[\w-]+\.\w+/i,
  },
  calendar: {
    purpose: 'Google Calendar: events, availability, create or change an event',
    pattern: /\b(?:calendar|meetings?|events?|appointments?|availability|free (?:slot|time)|invites?)\b/i,
  },
  memory: {
    purpose: 'durable memory: remember, recall or forget facts about the user',
    pattern: /\b(?:remember|memor(?:y|ies|i[sz]e)|forget|recall|about me|preferences?|(?:store|save|keep|note) (?:that|this|it)|keep (?:that |this |it )?in mind|from now on|next time|in (?:the )?future|future (?:chats?|conversations?|sessions?))\b/i,
  },
  reminders: {
    purpose: 'reminders and quick notes',
    pattern: /\b(?:remind\w*|reminders?|notes?|jot|write (?:this|that|it) down|alarm|nudge)\b/i,
  },
  scheduling: {
    purpose: 'scheduled and recurring tasks, commitments and follow-ups',
    pattern: /\b(?:schedul\w*|every (?:day|week|month|morning|evening|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|weekly|monthly|recurring|commitments?|promis\w*|follow[- ]?ups?|chase|deadlines?|due)\b/i,
  },
  household: {
    purpose: 'household routines, bills, warranties, renewals, organizing the PC',
    pattern: /\b(?:routines?|bills?|obligations?|warrant(?:y|ies)|renewals?|household|organi[sz]e)\b/i,
  },
  wish: {
    purpose: 'wishes: earn the money for something the user wants (goal, deliverable, orders, money records)',
    pattern: /\b(?:wish(?:es)?|wish list|earn (?:the )?money|side (?:income|business)|start (?:a|my) business|sell (?:my|online)|deliverables?)\b/i,
  },
  plan: {
    purpose: 'a step-by-step execution plan checked against what Pandesh can do',
    pattern: /\b(?:plan|step[- ]by[- ]step|phases?|roadmap)\b/i,
  },
  coding: {
    purpose: 'code in the selected project: run its checks and tests, delegate a code change to OpenCode',
    pattern: /\b(?:code|coding|bugs?|tests?|failing|defects?|refactor|compile|build|function|opencode|lint|typecheck|script)\b|\.(?:js|ts|tsx|py|java|cs|go|rs)\b/i,
  },
  dev_stories: {
    purpose: 'development stories for the dev team: plan, dispatch, review, retry, status',
    pattern: /\b(?:dev(?:eloper)? stor(?:y|ies)|stor(?:y|ies)|backlog|sprint|epics?)\b/i,
  },
  briefing: {
    purpose: 'the daily briefing: what is on today',
    pattern: /\b(?:briefing|brief me|morning (?:summary|update)|what'?s on (?:today|my day)|daily summary)\b/i,
  },
  printing: {
    purpose: 'printers: list them, print a test page',
    pattern: /\bprint\w*\b/i,
  },
  phone: {
    purpose: 'put a file on the paired phone',
    pattern: /\b(?:phone|mobile|smartphone|android|iphone)\b/i,
  },
  agents: {
    purpose: "hand work to Pandesh's specialist agents (Coding, Research, Operations, Personal) and get their result",
    pattern: /\b(?:delegate|hand (?:it|this|that) (?:off|over)|agents?|specialists?|(?:research|coding|operations|personal) (?:agent|team)|my team|ask (?:the )?(?:research|coding|operations)|have (?:the )?(?:research|coding|operations))\b/i,
  },
  workshop: {
    purpose: 'the Workshop: build an interactive 3D model, run a simulation or design a simple web page, change it, pull it apart, rotate it, play or pause it, preview it on a phone, export a GLB, show earlier versions',
    pattern: /\b(?:3-?d|three[- ]d|workshop|scenes?|assembl(?:y|ies)|gears?|gearbox|mechanism|mechanical|exploded?|explode|pull (?:it|them|this) apart|take (?:it|them) apart|put (?:it|them) back|reassembl\w*|rotate|turntable|label (?:the )?(?:components|parts)|components?|glb|gltf|export (?:the |this |it )?model|full[- ]?screen|previous version|undo that|simulat\w*|queues?|serving counters?|(?:another|second|extra) counter|arrival rate|waiting times?|pause (?:the |it)|speed (?:it |the simulation )?up|landing pages?|web ?pages?|home ?pages?|page design|mock-?ups?|headings?|contact button|hero section|call[- ]to[- ]action|(?:on|for) (?:a )?(?:phone|mobile|tablet)|show (?:me )?the code)\b/i,
  },
  weather: {
    purpose: 'weather and forecast',
    pattern: /\b(?:weather|forecast|temperature|rain\w*|snow\w*|sunny|umbrella|degrees|celsius)\b/i,
  },
};

/** Offered on every request. */
export const BASE_TOOLS = new Set([
  'request_tools', 'get_system_info', 'resolve_time', 'calculate', 'update_task_outcome',
  'list_directory', 'read_file', 'write_file', 'search_files', 'open_local_file',
  // Challenge (Project Birch): "When and where is the Project Birch review?" in a new chat searched files and said
  // nothing was known, because recall was only offered when the request said "remember"/"memory". Read-only.
  'memory_recall',
  // Only defined when the message came from a Pandesh window; one small definition, needed for "take me there".
  'navigate_to',
]);

export const NATIVE_GROUP: Record<string, string> = {
  request_search_permission: 'files_more', find_project_roots: 'files_more', find_duplicate_files: 'files_more',
  get_project_context: 'files_more', search_recent_projects: 'files_more',
  list_system_drives: 'pc',
  dev_stories_plan: 'dev_stories', dev_stories_dispatch: 'dev_stories', dev_story_reassign: 'dev_stories',
  dev_story_approve_review: 'dev_stories', dev_stories_stop_all: 'dev_stories', dev_story_retry: 'dev_stories', dev_stories_status: 'dev_stories',
  create_reminder: 'reminders', list_reminders: 'reminders', dismiss_reminder: 'reminders', create_note: 'reminders',
  create_commitment: 'scheduling', list_commitments: 'scheduling', update_commitment: 'scheduling',
  schedule_task: 'scheduling', list_scheduled_tasks: 'scheduling', cancel_scheduled_task: 'scheduling',
  create_wish_goal: 'wish', advance_wish: 'wish', wish_status: 'wish', update_wish_goal: 'wish', record_wish_money: 'wish',
  build_wish_deliverable: 'wish', wish_order: 'wish', wish_owner_decision: 'wish',
  get_briefing_data: 'briefing',
  web_research: 'web',
  run_checks: 'coding', delegate_to_opencode: 'coding', delegate_to_coding_agent: 'coding',
  list_printers: 'printing', print_test_page: 'printing',
  send_to_phone: 'phone',
  delegate_to_agent: 'agents',
  software_updates: 'pc', listening_ports: 'pc', find_installed_app: 'pc',
  create_project: 'projects', list_projects: 'projects',
};

/** Governed capability id → group. */
export const CAPABILITY_GROUP: Record<string, string> = {
  'image-studio': 'images',
  filesystem: 'documents',
  'document-tools': 'documents',
  household: 'household',
  'pc-organizer': 'household',
  plan: 'plan',
  wish: 'wish',
  browser: 'browser',
  research: 'web',
  'capability-inventory': 'pc',
  'system-management': 'pc',
  'port-management': 'pc',
  'computer-use': 'pc',
  'ollama-management': 'models',
  weather: 'weather',
  workshop: 'workshop',
};

/**
 * Capabilities the bridge selects on almost every request although few requests need them; they are offered only
 * when their group is pointed at (or requested).
 */
const GATED_CAPABILITIES = new Set(['ollama-management', 'capability-inventory']);

export interface CapabilityMark { capabilityId?: string; deferred?: boolean }

export function groupOfTool(name: string, capability?: CapabilityMark): string | null {
  if (BASE_TOOLS.has(name)) return null;
  if (NATIVE_GROUP[name]) return NATIVE_GROUP[name];
  if (name.startsWith('gmail_')) return 'email';
  if (name.startsWith('calendar_')) return 'calendar';
  if (name.startsWith('memory_')) return 'memory';
  if (capability?.capabilityId && CAPABILITY_GROUP[capability.capabilityId]) return CAPABILITY_GROUP[capability.capabilityId];
  return null;
}

export function groupsForText(text: string): Set<string> {
  const groups = new Set<string>();
  if (!text) return groups;
  for (const [group, spec] of Object.entries(TOOL_GROUPS)) if (spec.pattern.test(text)) groups.add(group);
  return groups;
}

/** A request that plainly asks Pandesh to make something in the Workshop: a 3D model, a simulation or a page. */
export const BUILD_3D_REQUEST = /\b(?:build|make|create|model|design|construct|generate)\b[^.?!]{0,80}\b(?:3-?d|three[- ]d|assembl(?:y|ies)|gears?|gearbox|mechanism|mechanical|model of)\b|\b(?:3-?d|three[- ]d) model\b|^\s*(?:please\s+)?(?:run\s+(?:a\s+)?)?simulat\w*\b|\b(?:build|make|create|design|generate|draft)\b[^.?!]{0,60}\b(?:landing pages?|web ?pages?|home ?pages?|page with)\b/i;

export interface ToolSelectionInput {
  requestText: string;
  /** The user's previous message in this conversation, for short follow-ups ("now make it a PDF"). */
  previousUserText?: string;
  /** Tools that ran in the last few turns of this conversation. */
  recentToolNames?: Iterable<string>;
  /** Governed capability tools: which capability owns each, and whether the bridge deferred it. */
  capabilities?: ReadonlyMap<string, CapabilityMark>;
}

export interface ToolSelection {
  /** Names offered on the first model call. */
  offered: Set<string>;
  /** Groups pointed at, with what pointed at them. */
  groups: Array<{ group: string; source: 'request' | 'previous_message' | 'recent_tool' }>;
}

export function selectChatTools(allNames: readonly string[], input: ToolSelectionInput): ToolSelection {
  const caps = input.capabilities ?? new Map<string, CapabilityMark>();
  const matched = new Map<string, 'request' | 'previous_message' | 'recent_tool'>();
  for (const g of groupsForText(input.requestText)) matched.set(g, 'request');
  for (const g of groupsForText(input.previousUserText ?? '')) if (!matched.has(g)) matched.set(g, 'previous_message');
  for (const name of input.recentToolNames ?? []) {
    const g = groupOfTool(name, caps.get(name));
    if (g && !matched.has(g)) matched.set(g, 'recent_tool');
  }
  const offered = new Set<string>();
  for (const name of allNames) {
    if (BASE_TOOLS.has(name)) { offered.add(name); continue; }
    const cap = caps.get(name);
    const group = groupOfTool(name, cap);
    if (group === null) { offered.add(name); continue; } // unknown tool: never hidden
    if (matched.has(group)) { offered.add(name); continue; }
    // A capability the bridge selected for this request stays, unless it is one of the near-always ones.
    if (cap && !cap.deferred && !(cap.capabilityId && GATED_CAPABILITIES.has(cap.capabilityId))) offered.add(name);
  }
  // "Build a gear assembly": a local model offered navigate_to opened Wish to Reality instead of building (Workshop
  // acceptance, 2026-11-11). For a request that plainly asks for a 3D model, the window navigation tool is not offered.
  if (matched.get('workshop') === 'request' && BUILD_3D_REQUEST.test(input.requestText)) offered.delete('navigate_to');
  return { offered, groups: [...matched].map(([group, source]) => ({ group, source })) };
}

/** Groups that still have tools to add, for the request_tools description. */
export function hiddenGroups(allNames: readonly string[], offered: ReadonlySet<string>, capabilities?: ReadonlyMap<string, CapabilityMark>): string[] {
  const groups = new Set<string>();
  for (const name of allNames) {
    if (offered.has(name)) continue;
    const g = groupOfTool(name, capabilities?.get(name));
    if (g) groups.add(g);
  }
  return Object.keys(TOOL_GROUPS).filter((g) => groups.has(g));
}

export function toolsInGroups(allNames: readonly string[], groups: readonly string[], capabilities?: ReadonlyMap<string, CapabilityMark>): string[] {
  const wanted = new Set(groups);
  return allNames.filter((name) => {
    const g = groupOfTool(name, capabilities?.get(name));
    return g !== null && wanted.has(g);
  });
}

/**
 * The model-facing copy of a Pi request context: tool declarations (on system messages, and `tools` when present)
 * limited to the offered names. The loop's own context, which decides what can execute, is left untouched.
 */
export function offerActiveTools<C extends { messages?: any[]; tools?: any[] }>(context: C, offered: ReadonlySet<string>): C {
  const keep = (list: any[] | undefined) => (Array.isArray(list) ? list.filter((t) => offered.has(t?.name)) : list);
  return {
    ...context,
    ...(Array.isArray(context.tools) ? { tools: keep(context.tools) } : {}),
    ...(Array.isArray(context.messages)
      ? { messages: context.messages.map((m) => (m && m.role === 'system' && Array.isArray(m.toolsAdded) ? { ...m, toolsAdded: keep(m.toolsAdded) } : m)) }
      : {}),
  };
}

export function describeRequestTools(groups: readonly string[]): string {
  const lines = groups.map((g) => `${g} (${TOOL_GROUPS[g].purpose})`).join('; ');
  return 'Your tools are the ones this request appears to need. If the task needs something you have no tool for, call '
    + `request_tools with the group names, then use the new tools. Groups you can add: ${lines}. `
    + 'Do not tell the user you cannot do something before checking whether a group covers it.';
}
