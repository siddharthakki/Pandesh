import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixture = path.resolve(process.env.KARKEDIKHA_TIP_CALCULATOR_REPO || path.join(repoRoot, '.tmp', 'tip-calculator'));

fs.rmSync(fixture, { recursive: true, force: true });
fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });

fs.writeFileSync(path.join(fixture, 'package.json'), `${JSON.stringify({
  name: 'tip-calculator',
  private: true,
  version: '0.0.1',
  type: 'module',
  scripts: {
    test: 'node --test tests/calculate.test.js',
    serve: 'node scripts/serve.mjs',
  },
}, null, 2)}\n`);

fs.writeFileSync(path.join(fixture, 'README.md'), `# Tip calculator

Small disposable web app used as a KarkeDikha Desktop acceptance fixture.

Open \`index.html\` or run \`npm run serve\`. Calculate a tip without reloading the page.
`);

fs.writeFileSync(path.join(fixture, 'src', 'calculate.js'), `export function parsePositiveNumber(value, label) {
  const text = String(value ?? '').trim();
  if (!text) return { ok: false, error: \`\${label} is required.\` };
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: \`\${label} must be a number greater than 0.\` };
  }
  return { ok: true, value: amount };
}

export function parsePeople(value) {
  const parsed = parsePositiveNumber(value, 'Number of people');
  if (!parsed.ok) return parsed;
  if (!Number.isInteger(parsed.value)) {
    return { ok: false, error: 'Number of people must be a whole number.' };
  }
  return parsed;
}

export function calculateTip({ bill, tipPercent, people }) {
  const billParsed = parsePositiveNumber(bill, 'Bill amount');
  if (!billParsed.ok) return billParsed;
  const tipParsed = parsePositiveNumber(tipPercent, 'Tip percent');
  if (!tipParsed.ok) return tipParsed;
  const peopleParsed = parsePeople(people);
  if (!peopleParsed.ok) return peopleParsed;

  const tipAmount = billParsed.value * (tipParsed.value / 100);
  const total = billParsed.value + tipAmount;
  const perPerson = total / peopleParsed.value;
  return {
    ok: true,
    bill: billParsed.value,
    tipPercent: tipParsed.value,
    people: peopleParsed.value,
    tipAmount,
    total,
    perPerson,
    effectiveTipPercent: tipParsed.value,
    rounded: false,
  };
}
`);

fs.writeFileSync(path.join(fixture, 'src', 'app.js'), `import { calculateTip } from './calculate.js';

const form = document.getElementById('tip-form');
const errorEl = document.getElementById('error');
const results = document.getElementById('results');

function money(value) {
  return \`$\${value.toFixed(2)}\`;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const result = calculateTip({
    bill: document.getElementById('bill').value,
    tipPercent: document.getElementById('tip-percent').value,
    people: document.getElementById('people').value,
  });
  if (!result.ok) {
    errorEl.textContent = result.error;
    errorEl.hidden = false;
    results.hidden = true;
    return;
  }
  errorEl.hidden = true;
  document.getElementById('tip-amount').textContent = money(result.tipAmount);
  document.getElementById('total').textContent = money(result.total);
  document.getElementById('per-person').textContent = money(result.perPerson);
  document.getElementById('effective-tip').textContent = \`\${result.effectiveTipPercent.toFixed(2)}%\`;
  results.hidden = false;
});
`);

fs.writeFileSync(path.join(fixture, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tip calculator</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main class="card">
    <h1>Tip calculator</h1>
    <form id="tip-form">
      <label for="bill">Bill amount</label>
      <input id="bill" name="bill" inputmode="decimal" value="86.50">
      <label for="tip-percent">Tip percent</label>
      <input id="tip-percent" name="tip-percent" inputmode="decimal" value="18">
      <label for="people">Number of people</label>
      <input id="people" name="people" inputmode="numeric" value="4">
      <button type="submit">Calculate</button>
    </form>
    <p id="error" class="error" hidden></p>
    <section id="results" hidden>
      <div>Tip: <strong id="tip-amount"></strong></div>
      <div>Total: <strong id="total"></strong></div>
      <div>Per person: <strong id="per-person"></strong></div>
      <div>Effective tip: <strong id="effective-tip"></strong></div>
    </section>
  </main>
  <script type="module" src="src/app.js"></script>
</body>
</html>
`);

fs.writeFileSync(path.join(fixture, 'styles.css'), `* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  font-family: Georgia, 'Times New Roman', serif;
  background: #f4efe6;
  color: #1f1a16;
  display: flex;
  justify-content: center;
  padding: 24px 16px;
}
.card {
  width: min(440px, 100%);
  background: #fffaf3;
  border: 1px solid #d8cbb8;
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 12px 32px rgba(80, 50, 20, 0.08);
}
h1 { margin-top: 0; font-size: 1.6rem; }
label { display: block; margin: 12px 0 6px; font-size: 0.95rem; }
input, button {
  width: 100%;
  font: inherit;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid #cbbba4;
}
button {
  margin-top: 16px;
  background: #1f6f4a;
  color: white;
  border: 0;
  font-weight: 700;
  cursor: pointer;
}
.error { color: #9b1c1c; }
#results { margin-top: 16px; display: grid; gap: 8px; }
@media (max-width: 420px) {
  body { padding: 12px; }
  .card { padding: 16px; border-radius: 12px; }
}
`);

fs.writeFileSync(path.join(fixture, 'tests', 'calculate.test.js'), `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateTip } from '../src/calculate.js';

test('splits a valid bill without rounding', () => {
  const result = calculateTip({ bill: '86.50', tipPercent: '18', people: '4' });
  assert.equal(result.ok, true);
  assert.equal(result.tipAmount.toFixed(4), '15.5700');
  assert.equal(result.total.toFixed(4), '102.0700');
  assert.equal(result.perPerson.toFixed(4), '25.5175');
  assert.equal(result.rounded, false);
});

test('rejects missing or invalid inputs and keeps the failure explicit', () => {
  assert.equal(calculateTip({ bill: '', tipPercent: '18', people: '2' }).ok, false);
  assert.equal(calculateTip({ bill: '20', tipPercent: '-1', people: '2' }).ok, false);
  assert.equal(calculateTip({ bill: '20', tipPercent: '18', people: '1.5' }).ok, false);
});
`);

fs.writeFileSync(path.join(fixture, 'scripts', 'serve.mjs'), `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4173);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\\/+/, '');
  const file = path.normalize(path.join(root, relative));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'text/plain; charset=utf-8' });
    res.end(data);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(\`tip calculator at http://127.0.0.1:\${port}/\`);
});
`);

execFileSync('git', ['init'], { cwd: fixture, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'desktop@karkedikha.local'], { cwd: fixture, stdio: 'ignore' });
execFileSync('git', ['config', 'user.name', 'KarkeDikha Desktop'], { cwd: fixture, stdio: 'ignore' });
execFileSync('git', ['add', '-A'], { cwd: fixture, stdio: 'ignore' });
execFileSync('git', ['commit', '-m', 'fixture baseline: tip calculator without round-up'], { cwd: fixture, stdio: 'ignore' });

const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();
const remotes = execFileSync('git', ['remote', '-v'], { cwd: fixture, encoding: 'utf8' }).trim();
const info = {
  fixture,
  baseline,
  remotes: remotes || '(none)',
  createdAt: new Date().toISOString(),
};
fs.mkdirSync(path.join(repoRoot, '.tmp'), { recursive: true });
fs.writeFileSync(path.join(repoRoot, '.tmp', 'tip-calculator-fixture.json'), JSON.stringify(info, null, 2));
console.log(JSON.stringify(info, null, 2));
