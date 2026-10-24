'use strict';

// This file is deliberately colocated with the companion extension so vsce
// includes it in the temporary, harness-only VSIX.
const fs = require('fs');
const path = require('path');

function writeJsonAtomic(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'w');
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filename);
}

function readJsonWithEvidence(filename) {
  const evidence = { sourcePath: filename, encoding: 'utf8', sourcePreserved: true, exists: fs.existsSync(filename) };
  if (!evidence.exists) return { ok: false, evidence: { ...evidence, classification: 'missing_json', parseError: `JSON evidence file does not exist: ${filename}` } };
  let originalText;
  try { originalText = fs.readFileSync(filename, 'utf8'); } catch (error) {
    return { ok: false, evidence: { ...evidence, classification: 'read_error', parseError: error instanceof Error ? error.message : String(error) } };
  }
  const bomRemoved = originalText.codePointAt(0) === 0xfeff;
  try { return { ok: true, value: JSON.parse(bomRemoved ? originalText.slice(1) : originalText), evidence: { ...evidence, bomRemoved, originalText } }; } catch (error) {
    return { ok: false, evidence: { ...evidence, bomRemoved, originalText, classification: 'invalid_json', parseError: error instanceof Error ? error.message : String(error) } };
  }
}

module.exports = { writeJsonAtomic, readJsonWithEvidence };
