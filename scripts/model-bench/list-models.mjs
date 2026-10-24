// npm run model:list — every installed Ollama model with its qualification category and why.
import { discoverModels } from './discover.mjs';

const models = discoverModels();
const pad = (value, width) => String(value ?? '').padEnd(width);
const nameWidth = Math.max(5, ...models.map(item => item.name.length)) + 2;
console.log(`${pad('MODEL', nameWidth)}${pad('CATEGORY', 18)}${pad('PARAMS', 8)}${pad('CTX', 9)}REASON`);
for (const item of models) {
  console.log(`${pad(item.name, nameWidth)}${pad(item.category, 18)}${pad(item.show?.parameters, 8)}${pad(item.show?.contextLength, 9)}${item.reason}${item.showError ? ` [ollama show failed: ${item.showError}]` : ''}`);
}
const count = category => models.filter(item => item.category === category).length;
console.log(`\n${models.length} models: ${count('CODING_CANDIDATE')} coding candidates, ${count('SPECIALIST')} specialists, ${count('RETRIEVAL')} retrieval, ${count('SKIPPED')} skipped`);
