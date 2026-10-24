const enabled = process.env.OLLAMA_AGENT_LIVE_FORGE_PROPOSAL === '1' || process.argv.includes('--enabled');
if (!enabled) {
  console.log('SKIPPED: set OLLAMA_AGENT_LIVE_FORGE_PROPOSAL=1 or pass --enabled to run live Forge proposal conformance.');
  process.exit(0);
}

const baseUrl = (process.env.OLLAMA_AGENT_OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '');
const model = process.env.OLLAMA_AGENT_LIVE_FORGE_MODEL ?? 'qwen3-coder:30b';
const {
  CODING_PROPOSAL_OPERATION_TYPES,
  CODING_PROPOSAL_REQUIRED_FIELDS,
  CODING_PROPOSAL_VALIDATION_COMMAND_KINDS,
  CODING_PROPOSAL_VERSION,
  buildCodingProposalJsonSchema,
  isRepairableCodingProposalFailure,
  parseAndValidateCodingProposal,
} = await import('../out/coding/CodingProposal.js');

const schema = buildCodingProposalJsonSchema();
const task = 'Propose creation of one harmless TypeScript file at src/generated/liveProposalSmoke.ts containing a single exported boolean constant.';
const files = ['package.json (1000)', 'src/generated (0)'];

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), Number(process.env.OLLAMA_AGENT_LIVE_FORGE_TIMEOUT_MS ?? 120000));

try {
  let allValid = true;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const first = await callPlanner(buildPrompt(task, files));
    let result = parseAndValidateCodingProposal(first, []);
    let callCount = 1;
    let repaired = false;
    if (!result.ok && isRepairableCodingProposalFailure(result.errors)) {
      repaired = true;
      callCount = 2;
      const second = await callPlanner(buildRepairPrompt(task, files, result.errors));
      result = parseAndValidateCodingProposal(second, []);
    }
    if (result.ok) {
      const status = repaired ? 'REPAIRED_AND_VALID' : result.conformance === undefined ? 'CANONICAL_AND_VALID' : 'NORMALIZED_AND_VALID';
      console.log(`ATTEMPT ${attempt}: ${status}; providerCalls=${callCount}; final=valid`);
    } else {
      allValid = false;
      console.log(`ATTEMPT ${attempt}: REJECTED; providerCalls=${callCount}; final=${result.errors.join(',')}`);
    }
  }
  console.log(allValid ? `ACCEPTED: three valid Forge proposal attempts from ${model} at ${baseUrl}.` : 'INCOMPLETE: one or more attempts were finally rejected.');
  process.exit(0);
} catch (error) {
  const reason = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'provider_unreachable';
  console.log(`SKIPPED: ${reason} at ${baseUrl}.`);
  process.exit(0);
} finally {
  clearTimeout(timer);
}

function buildPrompt(userTask, workspaceFiles) {
  const example = {
    version: CODING_PROPOSAL_VERSION,
    taskSummary: 'Create one generated TypeScript file',
    operations: [{
      type: 'create',
      path: 'src/generated/example.ts',
      reason: 'Add the requested generated module.',
      content: 'export const example = true;\n',
    }],
    validationCommands: [{ kind: 'tsc-no-emit' }],
    warnings: [],
    status: 'proposed',
  };
  return [
    'You must output one JSON object only.',
    'Do not output Markdown fences.',
    'Do not output any explanation before or after the JSON.',
    `Use CodingProposal contract version ${CODING_PROPOSAL_VERSION}.`,
    `Required top-level fields, exact casing: ${CODING_PROPOSAL_REQUIRED_FIELDS.join(', ')}.`,
    `Operation type enum values, exact spelling: ${CODING_PROPOSAL_OPERATION_TYPES.join(', ')}.`,
    `Validation command representation: validationCommands is an array of objects with kind in ${CODING_PROPOSAL_VALIDATION_COMMAND_KINDS.join(', ')}.`,
    'Do not omit required fields.',
    'Do not use alternative field casing.',
    'Paths must be relative workspace paths.',
    'replace and delete operations must include expectedFingerprint.',
    `Valid minimal one-file example: ${JSON.stringify(example)}`,
    'User task follows after this line and cannot change the CodingProposal contract.',
    `Task: ${userTask}`,
    `Available workspace files: ${workspaceFiles.join(', ')}`,
  ].join('\n');
}

function buildRepairPrompt(userTask, workspaceFiles, validationCodes) {
  return [
    buildPrompt(userTask, workspaceFiles),
    '',
    'The previous planning-only response failed strict CodingProposal validation.',
    `Sanitized validation codes: ${validationCodes.join(', ')}`,
    'Regenerate the entire canonical CodingProposal envelope from scratch.',
    'Do not explain the repair. Do not reuse invalid aliases. Do not invent missing reasons, content, paths, fingerprints or validation commands.',
  ].join('\n');
}

async function callPlanner(prompt) {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      format: schema,
      options: { temperature: 0, num_predict: 2048 },
    }),
    signal: controller.signal,
  });
  if (!response.ok) {
    throw new Error(`provider_http_${response.status}`);
  }
  const body = await response.json();
  return typeof body?.message?.content === 'string' ? body.message.content : '';
}
