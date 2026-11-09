/** Task-aware tool selection: what the first model call is offered for real requests (the frozen audit prompts). */
import { describe, expect, it } from 'vitest';
import { BASE_TOOLS, groupsForText, hiddenGroups, offerActiveTools, selectChatTools, toolsInGroups } from '../runtime/chatToolSelection';
import { buildPiCapabilityBridge } from '../runtime/piCapabilityBridge';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';

const NATIVE = [
  'get_system_info', 'open_local_file', 'list_system_drives', 'request_search_permission', 'find_project_roots', 'search_files', 'resolve_time',
  'dev_stories_plan', 'dev_stories_status', 'create_reminder', 'list_reminders', 'create_note', 'update_task_outcome',
  'create_commitment', 'create_wish_goal', 'wish_order', 'schedule_task', 'get_briefing_data', 'web_research',
  'list_directory', 'read_file', 'write_file', 'run_checks', 'delegate_to_opencode', 'calculate', 'list_printers',
  'print_test_page', 'send_to_phone', 'gmail_search', 'gmail_create_draft', 'calendar_create_event', 'memory_remember',
  'memory_recall', 'request_tools',
];
const CAPS = new Map<string, { capabilityId?: string; deferred?: boolean }>([
  ['ollama_list_models', { capabilityId: 'ollama-management' }],
  ['pc_capability_inventory', { capabilityId: 'capability-inventory' }],
  ['get_weather', { capabilityId: 'weather' }],
  ['governed_research', { capabilityId: 'research' }],
  ['image_generate', { capabilityId: 'image-studio', deferred: true }],
  ['document_read', { capabilityId: 'document-tools', deferred: true }],
  ['system_hardware_telemetry', { capabilityId: 'system-management' }],
]);
const ALL = [...NATIVE, ...CAPS.keys()];
const offered = (requestText: string, extra: Partial<Parameters<typeof selectChatTools>[1]> = {}) =>
  selectChatTools(ALL, { requestText, capabilities: CAPS, ...extra }).offered;

describe('base set', () => {
  it('a question with no tool group gets only the base tools and the capabilities the bridge chose', () => {
    const o = offered('What is 17 times 23?');
    for (const n of BASE_TOOLS) expect(o.has(n)).toBe(true);
    for (const n of ['gmail_search', 'calendar_create_event', 'memory_remember', 'wish_order', 'dev_stories_plan', 'print_test_page', 'ollama_list_models', 'pc_capability_inventory', 'image_generate']) expect(o.has(n)).toBe(false);
    expect(o.has('get_weather')).toBe(true); // selected by the bridge for this request
    expect(o.size).toBeLessThan(ALL.length / 2);
  });

  it('a tool the selection does not know is always offered', () => {
    expect(selectChatTools(['brand_new_tool', 'read_file'], { requestText: 'hi' }).offered.has('brand_new_tool')).toBe(true);
  });
});

describe('frozen audit prompts', () => {
  const cases: Array<[string, string, string[], string[]]> = [
    ['M1', 'Can you check my computer and tell me how much free space I have on C: and D:, which drive has more space available, and what NVIDIA GPU is installed? Please check the actual machine rather than guessing.', ['list_system_drives', 'system_hardware_telemetry', 'pc_capability_inventory'], ['gmail_search']],
    ['M3', "I'm preparing a catering estimate. I have 40 chicken biryani portions at €12 each and 25 vegetable biryani portions at €10 each. Delivery costs €35. Ingredient costs are €340 and packaging costs €45. Calculate revenue, expenses and profit, then create a CSV file with the breakdown.", ['calculate', 'write_file'], ['wish_order', 'create_wish_goal', 'gmail_search']],
    ['M4', 'Now turn that catering estimate into a professional one-page PDF report with the revenue, costs and profit. Save it in the same workspace and show me where I can open it.', ['document_read', 'write_file'], ['wish_order']],
    ['M6', "I'm preparing for the telc Deutsch B1 exam. Research the exam structure using official sources, explain the different sections, and give me links to the sources. Please distinguish confirmed facts from anything you cannot verify.", ['web_research', 'governed_research'], ['gmail_search']],
    ['M8', 'Use OpenCode to inspect this project, find why its tests are failing, fix the defect, and run the relevant tests. Show me exactly what you changed.', ['delegate_to_opencode', 'run_checks'], ['gmail_search']],
    ['M9', 'Read my CV from the selected folder and help me find suitable English-speaking product or project manager jobs in Germany. Search the public web for opportunities, but keep my CV and personal details private.', ['read_file', 'web_research', 'document_read'], ['gmail_search']],
    ['M11', 'Create a realistic image of a steaming plate of chicken biryani with raita, using my local image-generation tools. Save the resulting image so I can view it.', ['image_generate'], ['gmail_search']],
    ['C1', "I've put my suppliers' price lists in this folder. Which one is cheapest for basmati rice if I need 20 kg? Write me a short note called rice_order.txt saying who to order from and what it will cost in total.", ['list_directory', 'read_file', 'write_file', 'calculate'], ['wish_order']],
    ['C2', 'Remind me about my dentist appointment.', ['create_reminder', 'resolve_time'], ['wish_order']],
    ['C3', "Email the catering estimate PDF to my accountant at accountant@example.com and let me know once it's sent.", ['gmail_create_draft', 'gmail_search'], ['wish_order']],
    ['F3', "Change the line 'mode=safe' to 'mode=unsafe' in protected_config.txt.", ['read_file', 'write_file'], ['gmail_search', 'web_research']],
  ];
  it.each(cases)('%s gets the tools it needs', (_id, prompt, need, notNeeded) => {
    const o = offered(prompt);
    for (const n of need) expect(o.has(n), n).toBe(true);
    for (const n of notNeeded) expect(o.has(n), n).toBe(false);
  });

  it('M7 (follow-up) keeps the research group from the previous message', () => {
    const o = offered('Open one of those official exam information pages in the browser, inspect it, and explain what the page actually says about the exam sections. Tell me the page title too.', {
      previousUserText: "I'm preparing for the telc Deutsch B1 exam. Research the exam structure using official sources",
    });
    expect(o.has('web_research')).toBe(true);
  });
});

describe('follow-ups and expansion', () => {
  it('a group used in a recent turn stays offered ("send it now")', () => {
    expect(offered('ok, send it now', { recentToolNames: ['gmail_create_draft'] }).has('gmail_search')).toBe(true);
  });

  it('request_tools adds exactly the asked groups, including deferred capabilities', () => {
    const o = offered('What is 17 times 23?');
    const groups = hiddenGroups(ALL, o, CAPS);
    expect(groups).toEqual(expect.arrayContaining(['email', 'calendar', 'memory', 'images', 'documents', 'wish', 'models']));
    expect(toolsInGroups(ALL, ['email', 'images'], CAPS).sort()).toEqual(['gmail_create_draft', 'gmail_search', 'image_generate']);
  });

  it('"resume" and "profit" do not pull in documents or wishes', () => {
    expect(groupsForText('Resume the task and tell me the profit').has('documents')).toBe(false);
    expect(groupsForText('Resume the task and tell me the profit').has('wish')).toBe(false);
  });
});

describe('offerActiveTools', () => {
  it('limits the declarations the model sees and leaves the loop context alone', () => {
    const context = {
      tools: [{ name: 'read_file' }, { name: 'gmail_search' }],
      messages: [{ role: 'system', content: 's', toolsAdded: [{ name: 'read_file' }, { name: 'gmail_search' }] }, { role: 'user', content: 'hi' }],
    };
    const offeredCtx = offerActiveTools(context, new Set(['read_file']));
    expect(offeredCtx.tools.map((t) => t.name)).toEqual(['read_file']);
    expect((offeredCtx.messages[0] as any).toolsAdded.map((t: any) => t.name)).toEqual(['read_file']);
    expect(context.messages[0].toolsAdded).toHaveLength(2);
    expect(offeredCtx.messages[1]).toBe(context.messages[1]);
  });
});

describe('capability bridge marks', () => {
  it('a request-selected bridge defers the rest of the chat set and marks every definition with its capability', () => {
    const registry = new GovernedCapabilityRegistry();
    const adapter = (id: string, tool: string) => ({
      id,
      definitions: () => [{ name: tool, description: id, parameters: { type: 'object', properties: {} } }],
      classify: () => 'read_only' as const,
      health: () => ({ status: 'available' }) as any,
      run: async () => ({ status: 'succeeded', exitCode: 0, output: '' }) as any,
    });
    for (const [id, tool] of [['weather', 'get_weather'], ['image-studio', 'image_generate'], ['research', 'governed_research']] as const) {
      registry.register(adapter(id, tool) as any);
    }
    const bridge = buildPiCapabilityBridge({ db: {} as any, registry, correlationId: 'c', clientId: 'x', cwd: '.', actor: 'a', requestText: 'what is the weather' });
    const byName = new Map(bridge!.definitions.map((d) => [d.name, d]));
    expect(byName.get('get_weather')?.deferred).toBeUndefined();
    expect(byName.get('image_generate')?.deferred).toBe(true);
    expect(byName.get('image_generate')?.capabilityId).toBe('image-studio');
  });
});

describe('memory wording without "remember" (tool-selection run b9)', () => {
  it.each([
    "Store that I'm vegetarian so you know it in future chats.",
    'From now on, answer in German.',
    'Keep in mind that my accountant is Priya.',
  ])('%s offers the memory tools', (prompt) => {
    expect(offered(prompt).has('memory_remember')).toBe(true);
  });
});
