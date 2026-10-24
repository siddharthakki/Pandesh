// Benchmarks a local Laya System One server on KKD's actual routing decisions
// (not generic sentiment). Usage: node scripts/laya/benchmark-kkd-decisions.mjs [baseUrl]
import fs from 'node:fs';
import path from 'node:path';
import { resolveGoldenEvidenceRoot } from '../../src/ui-test/golden/goldenEvidenceRoot.mjs';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8771';
const WARM_RUNS = Number(process.env.LAYA_WARM_RUNS ?? 20);

const QUESTIONS = {
  intent: {
    type: 'choice',
    instructions: 'What does the user want KarkeDikha to do with their latest message?',
    criteria: {
      chat: 'Just talk: answer, explain or acknowledge; do not change any files.',
      bounded_edit: 'Make a small, specific change to the existing code or app.',
      autonomous_request: 'Build or deliver a whole feature or project end to end.',
    },
  },
  follow_up: {
    type: 'choice',
    instructions: 'What kind of follow-up is the latest user message?',
    criteria: {
      acknowledgement: 'A simple acknowledgement or thanks.',
      explanation: 'Asks the assistant to explain or justify something it said or did.',
      mutation: 'Asks for a change to be made or approves a proposed change.',
      new_topic: 'Starts an unrelated new topic.',
    },
  },
  same_context: {
    type: 'noul',
    instructions: 'Does the latest user message continue the same conversation context as the previous assistant message?',
    criteria: { false: 'It is unrelated to the previous assistant message.', true: 'It refers to or continues the previous assistant message.' },
  },
};

const A_QA = 'Total spending is the sum of all expense amounts stored in memory.';
const A_CHANGE = 'I added a remove(id) method to the expense store and wired a delete command in the CLI.';
const A_BUG = 'The bug is that the expense list is never saved to disk, so it is lost when the app closes.';
const A_PROPOSE = 'I can add a confirmation prompt before deleting. Shall I apply that change?';
const A_EXPORT = 'Working on adding a CSV export for your expenses.';

// expected: [intent, follow_up, same_context]
const CASES = [
  { text: 'Good.', prev: A_QA, expected: ['chat', 'acknowledgement', true] },
  { text: 'Good. Now change it.', prev: A_QA, expected: ['bounded_edit', 'mutation', true] },
  { text: 'Why did you do that?', prev: A_CHANGE, expected: ['chat', 'explanation', true] },
  { text: 'Explain what you changed.', prev: A_CHANGE, expected: ['chat', 'explanation', true] },
  { text: 'Okay, fix it.', prev: A_BUG, expected: ['bounded_edit', 'mutation', true] },
  { text: 'Do that.', prev: A_PROPOSE, expected: ['bounded_edit', 'mutation', true] },
  { text: 'Yes.', prev: A_PROPOSE, expected: ['bounded_edit', 'mutation', true] },
  { text: 'Yes, apply that.', prev: A_PROPOSE, expected: ['bounded_edit', 'mutation', true] },
  { text: 'Build this whole feature.', prev: A_QA, expected: ['autonomous_request', 'mutation', true] },
  { text: "Don't change anything, just explain it.", prev: A_CHANGE, expected: ['chat', 'explanation', true] },
  { text: 'Actually, make it Excel.', prev: A_EXPORT, expected: ['bounded_edit', 'mutation', true] },
  { text: 'Also keep this dependency-free.', prev: A_CHANGE, expected: ['bounded_edit', 'mutation', true] },
];

async function decide(item) {
  const state = `Previous assistant message: ${item.prev}\nLatest user message: ${item.text}`;
  const started = performance.now();
  const response = await fetch(`${baseUrl}/v1/systemone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state, questions: QUESTIONS }),
  });
  const body = await response.json().catch(() => ({}));
  const ms = performance.now() - started;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return { ms, body };
}

const pick = body => {
  const answers = body.answers ?? body;
  const read = key => answers?.[key]?.choice ?? answers?.[key]?.answer ?? answers?.[key]?.value ?? answers?.[key];
  return {
    intent: read('intent'),
    follow_up: read('follow_up'),
    same_context: (() => {
      const value = answers?.same_context;
      if (value && typeof value === 'object') return Number(value.noul ?? value.probability ?? value.value ?? 0) >= 0.5;
      return value;
    })(),
  };
};

const errors = [];
const first = await decide(CASES[0]);
const rows = [];
let exact = 0;
const perQuestion = { intent: 0, follow_up: 0, same_context: 0 };
for (const item of CASES) {
  try {
    const { ms, body } = await decide(item);
    const got = pick(body);
    const ok = [got.intent === item.expected[0], got.follow_up === item.expected[1], got.same_context === item.expected[2]];
    ok.forEach((value, index) => { if (value) perQuestion[['intent', 'follow_up', 'same_context'][index]] += 1; });
    if (ok.every(Boolean)) exact += 1;
    rows.push({ text: item.text, expected: item.expected, got: [got.intent, got.follow_up, got.same_context], ok, ms: Math.round(ms), confidence: body.confidence ?? body.calibrated_confidence ?? null });
  } catch (error) {
    errors.push(String(error));
  }
}

const warm = [];
for (let run = 0; run < WARM_RUNS; run += 1) {
  for (const item of CASES) {
    try { warm.push((await decide(item)).ms); } catch (error) { errors.push(String(error)); }
  }
}
warm.sort((a, b) => a - b);
const pct = q => warm.length ? Math.round(warm[Math.min(warm.length - 1, Math.floor(q * warm.length))] * 10) / 10 : null;
const result = {
  baseUrl,
  firstInferenceMs: Math.round(first.ms),
  warm: { runs: warm.length, p50Ms: pct(0.5), p95Ms: pct(0.95), maxMs: warm.length ? Math.round(warm.at(-1) * 10) / 10 : null },
  errors: errors.length,
  errorSamples: errors.slice(0, 3),
  accuracy: { exactAllThree: `${exact}/${CASES.length}`, intent: `${perQuestion.intent}/${CASES.length}`, follow_up: `${perQuestion.follow_up}/${CASES.length}`, same_context: `${perQuestion.same_context}/${CASES.length}` },
  rows,
  sampleRawResponse: (await decide(CASES[1])).body,
};
const out = path.join(resolveGoldenEvidenceRoot(),`laya-benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ ...result, rows: undefined, evidence: out }, null, 2));
for (const row of rows) console.log(`${row.ok.every(Boolean) ? 'OK ' : 'MISS'} ${row.text.padEnd(42)} expected=${row.expected.join('/')} got=${row.got.join('/')} ${row.ms}ms`);
