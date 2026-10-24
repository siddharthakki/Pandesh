/**
 * Bulk that the failing path never touches, so the repository is larger than a small model's context pack and the
 * one relevant dependency is not shown just because everything is. Deterministic.
 */
const NOISE_DOMAINS = ['catalog', 'reviews', 'wishlist', 'coupons', 'returns', 'loyalty', 'giftcards', 'search', 'recommend', 'analytics', 'audit', 'notifications'];

function noiseModule(domain: string): string {
  const names = Array.from({ length: Number(process.env.OLLAMA_AGENT_M46_NOISE_HELPERS ?? 4) }, (_, index) => `${domain}Helper${index + 1}`);
  const functions = names.map((name, index) => `
// ${domain}: helper ${index + 1} normalises a ${domain} record before it is stored or listed.
function ${name}(record) {
  const id = String(record.id ?? '').trim();
  const label = String(record.name ?? '').trim().toLowerCase();
  if (!id) throw new Error('${domain} record needs an id');
  return { id, label, key: \`${domain}:\${id}:\${label}\`, position: ${index + 1} };
}`).join('\n');
  return `'use strict';\n${functions}\n\nmodule.exports = { ${names.join(', ')} };\n`;
}

export function ladderNoiseFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  // Off by default: with a bulky repository the unknown-model repair prompt can exceed the dispatch preflight limit
  // ("rejected before execution"), which is a separate finding from the ladder.
  if (process.env.OLLAMA_AGENT_M46_NOISE !== '1') return files;
  for (const domain of NOISE_DOMAINS.slice(0, Number(process.env.OLLAMA_AGENT_M46_NOISE_DOMAINS ?? 8))) files[`src/${domain}.js`] = noiseModule(domain);
  return files;
}
