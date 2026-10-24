'use strict';

// Harness-only JSON persistence. Atomic replacement prevents an observer from
// seeing a half-written status file; the explicit UTF-8 encoding keeps
// PowerShell 5.1's UTF-8-with-BOM default out of cross-process evidence.

const fs = require('fs');
const path = require('path');

function ensureParentDirectory(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJsonAtomic(filename, value) {
  ensureParentDirectory(filename);
  const temporary = `${filename}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const content = serializeJson(value);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'w');
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filename);
  return { path: filename, bytes: Buffer.byteLength(content, 'utf8') };
}

function readJsonWithEvidence(filename) {
  const evidence = {
    sourcePath: filename,
    encoding: 'utf8',
    sourcePreserved: true,
    exists: fs.existsSync(filename),
  };
  if (!evidence.exists) {
    return { ok: false, evidence: { ...evidence, classification: 'missing_json', parseError: `JSON evidence file does not exist: ${filename}` } };
  }

  let originalText;
  try {
    originalText = fs.readFileSync(filename, 'utf8');
  } catch (error) {
    return {
      ok: false,
      evidence: {
        ...evidence,
        classification: 'read_error',
        parseError: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const bomRemoved = originalText.codePointAt(0) === 0xfeff;
  const text = bomRemoved ? originalText.slice(1) : originalText;
  try {
    return { ok: true, value: JSON.parse(text), evidence: { ...evidence, bomRemoved, originalText } };
  } catch (error) {
    return {
      ok: false,
      evidence: {
        ...evidence,
        bomRemoved,
        originalText,
        classification: 'invalid_json',
        parseError: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

module.exports = { ensureParentDirectory, writeJsonAtomic, readJsonWithEvidence };
