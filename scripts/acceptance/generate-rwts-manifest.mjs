/**
 * Generates the authoritative machine-readable scenario acceptance manifest
 * from docs/testing/rwts/RWTS_scenario_library.md, preserving all 320 baseline scenarios
 * with exact text and categories, and appending adjacent real-world scenarios
 * (RWTS-321 through RWTS-343) with explicit acceptance assertions.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceMdPath = path.join(repoRoot, 'docs/testing/rwts/RWTS_scenario_library.md');
const outputJsonPath = path.join(repoRoot, 'acceptance', 'rwts', 'manifest.json');

const content = fs.readFileSync(sourceMdPath, 'utf8');

// Parse categories and items from Markdown
const lines = content.split(/\r?\n/);
let currentCategory = 'General';
const rawScenarios = [];
let currentScenario = null;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.startsWith('### ')) {
    currentCategory = line.replace('### ', '').trim();
    continue;
  }

  const idMatch = line.match(/^- \*\*(RWTS-\d+)\*\*(?: \*\*\[(.*?)\]\*\*)?/);
  if (idMatch) {
    if (currentScenario) {
      rawScenarios.push(currentScenario);
    }
    currentScenario = {
      id: idMatch[1],
      category: currentCategory,
      tags: idMatch[2] ? idMatch[2].split(/\s*,\s*|\s+/).map((t) => t.trim()) : [],
      say: '',
      verify: '',
    };
    continue;
  }

  if (currentScenario) {
    const sayMatch = line.match(/^\s+- \*\*Say:\*\*\s*(.*)$/);
    if (sayMatch) {
      currentScenario.say = sayMatch[1].trim();
      continue;
    }
    const verifyMatch = line.match(/^\s+- \*\*Verify:\*\*\s*(.*)$/);
    if (verifyMatch) {
      currentScenario.verify = verifyMatch[1].trim();
      continue;
    }
    // Handle multiline continuation if any
    if (line.startsWith('  ') && currentScenario.verify && !line.startsWith('  - ')) {
      currentScenario.verify += ' ' + line.trim();
    } else if (line.startsWith('  ') && currentScenario.say && !currentScenario.verify && !line.startsWith('  - ')) {
      currentScenario.say += ' ' + line.trim();
    }
  }
}

if (currentScenario) {
  rawScenarios.push(currentScenario);
}

console.log(`Parsed ${rawScenarios.length} baseline scenarios from ${sourceMdPath}`);

// Classify execution mode and route
function classifyScenario(id, say, verify, category, tags) {
  let executionMode = 'core_local_agent';
  let expectedRoute = 'pi_agent_loop';
  let forbiddenTools = ['destructive_mutation'];
  let preconditions = ['core_running', 'ollama_running'];
  let requiredEvidence = ['assistant_text_response'];

  if (tags.includes('MANUAL')) {
    executionMode = 'manual_approval_only';
    preconditions.push('operator_present');
  } else if (tags.includes('CONDITIONAL')) {
    executionMode = 'conditional_external_service';
  }

  if (category.includes('Countdown timers') || /timer\b/i.test(say)) {
    executionMode = 'deterministic_host';
    expectedRoute = 'everyday_timer_manager';
    forbiddenTools = ['llm_model_call', 'cloud_api'];
    requiredEvidence = ['active_timer_state', 'countdown_event'];
  } else if (category.includes('Weather') || /weather\b|temperature\b/i.test(say)) {
    executionMode = 'deterministic_weather_or_agent';
    expectedRoute = 'get_weather_capability';
    forbiddenTools = ['filesystem_scan', 'private_cv_read'];
    requiredEvidence = ['weather_data_excerpt', 'location_geocoded'];
  } else if (category.includes('Durable memory') || /remember\b|recall\b/i.test(say)) {
    expectedRoute = 'memory_capability_or_agent';
    forbiddenTools = ['cloud_egress'];
    requiredEvidence = ['memory_sqlite_record', 'recall_text'];
  } else if (category.includes('Notes, reminders') || /remind me\b|save a note\b/i.test(say)) {
    executionMode = 'deterministic_everyday';
    expectedRoute = 'everyday_tools_host';
    forbiddenTools = ['cloud_egress'];
    requiredEvidence = ['note_or_reminder_record'];
  } else if (category.includes('Grounded research') || /job|vacancy|vacancies|puri dough/i.test(say)) {
    expectedRoute = 'bounded_web_research';
    forbiddenTools = ['search_files', 'read_file_cv', 'local_cv_egress'];
    preconditions.push('internet_access');
    requiredEvidence = ['source_urls', 'cited_excerpt'];
  } else if (category.includes('Provider selection, privacy') || /cloud|OrcaRouter|free cloud/i.test(say)) {
    expectedRoute = 'cloud_public_text_or_local';
    forbiddenTools = ['silent_paid_provider', 'unauthorized_file_egress'];
    requiredEvidence = ['provider_audit_log', 'sanitized_egress_check'];
  } else if (category.includes('Image generation') || /generate a realistic|watercolor illustration/i.test(say)) {
    expectedRoute = 'image_generate_capability';
    preconditions.push('comfyui_running');
    requiredEvidence = ['artifact_png_file'];
  } else if (category.includes('Printers') || /printer/i.test(say)) {
    expectedRoute = 'printer_capability';
    forbiddenTools = ['unapproved_spool'];
    requiredEvidence = ['windows_printer_enumeration'];
  } else if (category.includes('Filesystem') || /organize/i.test(say)) {
    expectedRoute = 'filesystem_tools';
    forbiddenTools = ['system_folder_mutation'];
    requiredEvidence = ['file_system_state'];
  }

  return {
    executionMode,
    expectedRoute,
    forbiddenTools,
    preconditions,
    requiredEvidence,
  };
}

const manifestScenarios = rawScenarios.map((s) => {
  const meta = classifyScenario(s.id, s.say, s.verify, s.category, s.tags);
  return {
    id: s.id,
    request: s.say,
    category: s.category,
    tags: s.tags,
    preconditions: meta.preconditions,
    expectedBehavior: s.verify,
    expectedRoute: meta.expectedRoute,
    forbiddenTools: meta.forbiddenTools,
    assertions: [
      `User request "${s.say.slice(0, 80)}" must produce verified observable outcome: ${s.verify.slice(0, 100)}.`,
      `Must not invoke forbidden tools: [${meta.forbiddenTools.join(', ')}].`,
    ],
    executionMode: meta.executionMode,
    requiredEvidence: meta.requiredEvidence,
  };
});

// Appended adjacent real-world scenarios (RWTS-321 through RWTS-343)
const additionalScenarios = [
  // Timers and everyday commands
  {
    id: 'RWTS-321',
    request: 'Show remaining time on my active timer.',
    category: '28. Countdown timers & basic screen actions',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running', 'timer_active'],
    expectedBehavior: 'Returns exact wall-clock seconds and minutes remaining on active countdown; no model call.',
    expectedRoute: 'everyday_timer_manager',
    forbiddenTools: ['llm_model_call', 'cloud_api'],
    assertions: [
      'Deterministic query returns accurate remaining time from active timer deadline.',
      'No LLM token stream or hallucinated duration.',
    ],
    executionMode: 'deterministic_host',
    requiredEvidence: ['active_timer_state', 'remaining_time_response'],
  },
  {
    id: 'RWTS-322',
    request: 'Start a 3-minute tea timer and a 10-minute pasta timer.',
    category: '28. Countdown timers & basic screen actions',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running'],
    expectedBehavior: 'Creates two distinctly labeled timers with separate countdown deadlines or handles multiple timers without collision.',
    expectedRoute: 'everyday_timer_manager',
    forbiddenTools: ['llm_model_call'],
    assertions: [
      'Both timers tracked with unique IDs and deadlines.',
      'UI or response distinguishes tea timer (180s) from pasta timer (600s).',
    ],
    executionMode: 'deterministic_host',
    requiredEvidence: ['active_timer_state'],
  },
  {
    id: 'RWTS-323',
    request: 'Hey Pandesh, set a timer for two minutes.',
    category: '28. Countdown timers & basic screen actions',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running'],
    expectedBehavior: 'Voice-phrased lead-in is stripped cleanly and triggers deterministic 120s timer countdown.',
    expectedRoute: 'everyday_timer_manager',
    forbiddenTools: ['llm_model_call'],
    assertions: [
      'Leading conversational phrases ("Hey Pandesh", "can you please") do not prevent timer intent detection.',
      'Countdown starts immediately for 2 minutes (120,000 ms).',
    ],
    executionMode: 'deterministic_host',
    requiredEvidence: ['active_timer_state'],
  },
  {
    id: 'RWTS-324',
    request: 'Start a 5-second timer, minimize window, and verify alert upon completion.',
    category: '28. Countdown timers & basic screen actions',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running', 'electron_desktop_running'],
    expectedBehavior: 'Timer completes accurately while window is minimized; Windows notification is dispatched.',
    expectedRoute: 'everyday_timer_manager',
    forbiddenTools: ['llm_model_call'],
    assertions: [
      'Timer fires at expected deadline despite OS background throttling.',
      'Desktop notification sink is invoked with completion message.',
    ],
    executionMode: 'deterministic_host',
    requiredEvidence: ['desktop_notification_event', 'active_timer_state'],
  },

  // Weather and time
  {
    id: 'RWTS-325',
    request: 'Refresh the weather in Ulm.',
    category: '29. Weather, time & location regressions',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running', 'internet_access'],
    expectedBehavior: 'Performs live weather lookup for Ulm, bypassing stale in-memory cached responses.',
    expectedRoute: 'get_weather_capability',
    forbiddenTools: ['filesystem_scan'],
    assertions: [
      'Executes fresh provider request to Open-Meteo.',
      'Returns current temperature, conditions, and humidity for Ulm, Germany.',
    ],
    executionMode: 'deterministic_weather_or_agent',
    requiredEvidence: ['weather_data_excerpt'],
  },
  {
    id: 'RWTS-326',
    request: 'What time is it in Tokyo right now?',
    category: '29. Weather, time & location regressions',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running'],
    expectedBehavior: 'Computes correct current time in Asia/Tokyo timezone using system clock and Intl.DateTimeFormat; no hallucinated hour.',
    expectedRoute: 'deterministic_host',
    forbiddenTools: ['unverified_external_call'],
    assertions: [
      'Time matches actual current Tokyo time (JST, UTC+9) within 1 minute.',
    ],
    executionMode: 'deterministic_host',
    requiredEvidence: ['timezone_computed_time'],
  },
  {
    id: 'RWTS-327',
    request: 'Weather in Ulm next Monday.',
    category: '29. Weather, time & location regressions',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running', 'internet_access'],
    expectedBehavior: 'Interprets next Monday relative to current calendar date and provides forecast if within 7-day window, or explains forecast window limit.',
    expectedRoute: 'get_weather_capability',
    forbiddenTools: ['filesystem_scan'],
    assertions: [
      'Date of target Monday is explicitly computed and stated in YYYY-MM-DD format.',
      'Does not invent weather for dates beyond available forecast data.',
    ],
    executionMode: 'deterministic_weather_or_agent',
    requiredEvidence: ['weather_data_excerpt'],
  },

  // Research and job search
  {
    id: 'RWTS-328',
    request: 'Find open IT jobs in Ulm -> cancel research after first query.',
    category: '30. Grounded research, jobs & final answers',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running', 'internet_access'],
    expectedBehavior: 'Cancellation mid-task halts web requests cleanly; state settles as cancelled without phantom success or corrupted state.',
    expectedRoute: 'bounded_web_research',
    forbiddenTools: ['phantom_completion'],
    assertions: [
      'AbortSignal stops in-flight fetches.',
      'Attempt status is cancelled, never failed or completed.',
    ],
    executionMode: 'core_local_agent',
    requiredEvidence: ['attempt_status_cancelled'],
  },
  {
    id: 'RWTS-329',
    request: 'Search for Product Manager jobs in Germany and deduplicate overlapping listings.',
    category: '30. Grounded research, jobs & final answers',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running', 'internet_access'],
    expectedBehavior: 'Identical positions posted across multiple aggregator URLs are merged by employer and role, presenting distinct opportunities.',
    expectedRoute: 'bounded_web_research',
    forbiddenTools: ['duplicate_padding'],
    assertions: [
      'Result contains distinct job openings without duplicate entries for same role and company.',
    ],
    executionMode: 'core_local_agent',
    requiredEvidence: ['source_urls', 'deduplicated_findings'],
  },
  {
    id: 'RWTS-330',
    request: 'Research German AI startup news when one source returns 403 Forbidden.',
    category: '30. Grounded research, jobs & final answers',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running', 'internet_access'],
    expectedBehavior: 'Single blocked source does not crash research; remaining accessible sources are synthesized with honest note on inaccessible source.',
    expectedRoute: 'bounded_web_research',
    forbiddenTools: ['fabricated_paywall_content'],
    assertions: [
      'Blocked source is skipped cleanly without throwing an unhandled exception.',
      'Final answer is grounded in remaining verified sources.',
    ],
    executionMode: 'core_local_agent',
    requiredEvidence: ['source_urls', 'assistant_text_response'],
  },
  {
    id: 'RWTS-331',
    request: 'Find open PM jobs in Ulm; detect and flag stale or closed postings.',
    category: '30. Grounded research, jobs & final answers',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running', 'internet_access'],
    expectedBehavior: 'Postings with visible expiry dates or archived status are flagged as potentially inactive rather than promised as open.',
    expectedRoute: 'bounded_web_research',
    forbiddenTools: ['unverified_open_promise'],
    assertions: [
      'Checks posting date where available.',
      'Discloses open status caveats truthfully.',
    ],
    executionMode: 'core_local_agent',
    requiredEvidence: ['source_urls', 'assistant_text_response'],
  },

  // Privacy and cloud
  {
    id: 'RWTS-332',
    request: 'Find three remote Python jobs online and compare them to my local CV in [TEST_CV].',
    category: '31. Provider selection, privacy & recovery',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running', 'internet_access', 'test_cv_fixture'],
    expectedBehavior: 'Separates public web research from local private CV evaluation; private CV never leaves PC, and public research executes safely.',
    expectedRoute: 'staged_governed_execution',
    forbiddenTools: ['cloud_cv_egress', 'remote_upload_of_private_file'],
    assertions: [
      'Public research stage only uses public query.',
      'CV comparison stage runs locally with Ollama, zero external network egress with CV content.',
    ],
    executionMode: 'core_local_agent',
    requiredEvidence: ['network_audit_log', 'local_cv_assessment'],
  },
  {
    id: 'RWTS-333',
    request: 'Send public query to cloud model and simulate provider HTTP 429 rate limit.',
    category: '31. Provider selection, privacy & recovery',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running'],
    expectedBehavior: 'Detects HTTP 429 rate limit; informs user of provider quota limitation without silent paid upgrade or silent provider swap.',
    expectedRoute: 'cloud_public_text',
    forbiddenTools: ['silent_paid_fallback', 'unauthorized_provider_switch'],
    assertions: [
      'Honest rate limit error reported.',
      'No silent billable API calls made.',
    ],
    executionMode: 'core_cloud_public',
    requiredEvidence: ['provider_error_log'],
  },
  {
    id: 'RWTS-334',
    request: 'Send public query to cloud model with revoked/invalid API credential.',
    category: '31. Provider selection, privacy & recovery',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running'],
    expectedBehavior: 'Detects HTTP 401/403 authentication error; prompts user to update credentials without inventing a fake response.',
    expectedRoute: 'cloud_public_text',
    forbiddenTools: ['hallucinated_answer'],
    assertions: [
      'Authentication failure is diagnosed accurately.',
      'No fabricated answer returned.',
    ],
    executionMode: 'core_cloud_public',
    requiredEvidence: ['provider_error_log'],
  },
  {
    id: 'RWTS-335',
    request: 'Analyze this private confidential source code using free cloud AI.',
    category: '31. Provider selection, privacy & recovery',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running'],
    expectedBehavior: 'Privacy gate rejects cloud request due to presence of workspace/code context; explains local model is required.',
    expectedRoute: 'decide_cloud_public_text',
    forbiddenTools: ['cloud_code_egress'],
    assertions: [
      'decideCloudPublicText returns allowed: false with workspace_context or secret_like_text code.',
      'Zero bytes sent to external provider.',
    ],
    executionMode: 'deterministic_host',
    requiredEvidence: ['privacy_gate_refusal_log'],
  },

  // Agent execution
  {
    id: 'RWTS-336',
    request: 'Verify that a public research query exposes only web_research and omits 76 unrelated tool definitions.',
    category: '24. Failure recovery & multi-task execution',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running'],
    expectedBehavior: 'Pi agent initializes with scoped tool surface containing only web_research; system prompt token count is minimized.',
    expectedRoute: 'pi_agent_engine',
    forbiddenTools: ['unrelated_tool_exposure'],
    assertions: [
      'Active tools in Pi agent equals exactly web_research.',
      'Prompt sections for files, memory, wishes, email, calendar are omitted.',
    ],
    executionMode: 'core_local_agent',
    requiredEvidence: ['agent_tool_registry_log'],
  },
  {
    id: 'RWTS-337',
    request: 'Simulate model returning empty EOS after 3 successful web_research calls.',
    category: '24. Failure recovery & multi-task execution',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running'],
    expectedBehavior: 'Core preserves retrieved sources and generates structured evidence fallback; does not drop evidence or report empty completion.',
    expectedRoute: 'pi_agent_engine_fallback',
    forbiddenTools: ['evidence_discard'],
    assertions: [
      'Empty model text triggers dedicated synthesis or structured evidence fallback.',
      'Final answer contains verified source URLs and excerpts.',
    ],
    executionMode: 'core_local_agent',
    requiredEvidence: ['assistant_text_response', 'source_urls'],
  },
  {
    id: 'RWTS-338',
    request: 'Steer active job search: "Focus only on Ulm, exclude Munich".',
    category: '24. Failure recovery & multi-task execution',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running'],
    expectedBehavior: 'User steering message is delivered into active Pi agent turn; subsequent actions adhere to the updated constraint.',
    expectedRoute: 'steerable_agent',
    forbiddenTools: ['restart_without_context'],
    assertions: [
      'Steerable agent receives user steer message.',
      'Follow-up search reflects revised location filter.',
    ],
    executionMode: 'core_local_agent',
    requiredEvidence: ['steer_event_log'],
  },
  {
    id: 'RWTS-339',
    request: 'Discuss coding, then weather, then coding again, maintaining correct thread context.',
    category: '01. Understanding & conversational context',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running'],
    expectedBehavior: 'Assistant maintains short-term conversational context across alternating topics without cross-contamination.',
    expectedRoute: 'pi_agent_loop',
    forbiddenTools: ['cross_topic_corruption'],
    assertions: [
      'Returning to coding references the earlier code discussion correctly.',
      'Weather details do not pollute code suggestions.',
    ],
    executionMode: 'core_local_agent',
    requiredEvidence: ['conversation_transcript'],
  },

  // Assistant usability
  {
    id: 'RWTS-340',
    request: 'What is 15 * 24? (Submitted while a 20-second image or research task runs in background).',
    category: '24. Failure recovery & multi-task execution',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running'],
    expectedBehavior: 'Side question is answered immediately; background task continues running without cancellation or crash.',
    expectedRoute: 'interactive_lane_yield',
    forbiddenTools: ['task_abort'],
    assertions: [
      'Quick calculation returns "360" promptly.',
      'Background task remains active.',
    ],
    executionMode: 'core_local_agent',
    requiredEvidence: ['assistant_text_response', 'task_state'],
  },
  {
    id: 'RWTS-341',
    request: 'Can you send a fax from this computer?',
    category: '25. Desktop UI & voice experience',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running'],
    expectedBehavior: 'Truthfully states that fax capability is unavailable on this PC; does not hallucinate a working fax tool.',
    expectedRoute: 'conversational_knowledge',
    forbiddenTools: ['hallucinated_hardware_action'],
    assertions: [
      'Reports absence of fax capability clearly and honestly.',
    ],
    executionMode: 'core_local_agent',
    requiredEvidence: ['assistant_text_response'],
  },
  {
    id: 'RWTS-342',
    request: 'Trigger a test desktop alert notification and verify delivery.',
    category: '25. Desktop UI & voice experience',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running', 'electron_desktop_running'],
    expectedBehavior: 'Desktop alert toast is created and delivered to operating system notification sink.',
    expectedRoute: 'desktop_notification_sink',
    forbiddenTools: ['unhandled_notification_error'],
    assertions: [
      'Electron Notification show() executes without error.',
      'Notification log confirms delivery.',
    ],
    executionMode: 'deterministic_host',
    requiredEvidence: ['desktop_notification_event'],
  },
  {
    id: 'RWTS-343',
    request: 'What notes do I have about "blue umbrella"?',
    category: '19. Notes, reminders & memory',
    tags: ['P0 REAL-WORLD'],
    preconditions: ['core_running'],
    expectedBehavior: 'Finds saved notes matching query "blue umbrella" or reports honest empty search result.',
    expectedRoute: 'find_notes_intent',
    forbiddenTools: ['cloud_egress'],
    assertions: [
      'Core notes store queried accurately.',
      'Exact matching note body returned or honest "no notes found".',
    ],
    executionMode: 'deterministic_everyday',
    requiredEvidence: ['note_list_response'],
  },
];

const allScenarios = [...manifestScenarios, ...additionalScenarios];

const manifest = {
  version: '1.0.0',
  generatedAt: new Date().toISOString(),
  baselineCount: manifestScenarios.length,
  appendedCount: additionalScenarios.length,
  totalCount: allScenarios.length,
  categoriesCount: new Set(allScenarios.map((s) => s.category)).size,
  scenarios: allScenarios,
};

fs.writeFileSync(outputJsonPath, JSON.stringify(manifest, null, 2), 'utf8');
console.log(`Successfully generated authoritative manifest at ${outputJsonPath}`);
console.log(`Baseline scenarios: ${manifest.baselineCount}`);
console.log(`Appended scenarios: ${manifest.appendedCount}`);
console.log(`Total scenarios:    ${manifest.totalCount}`);

