import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AUTHORIZE_MISSION_TOOL,
  buildMissionEnvelope,
  contentDigest,
  evaluateMissionAction,
  missionEnvelopeDigest,
} from '../runtime/missionAuthorization';

const envelope = buildMissionEnvelope({
  workspaceRoot: path.join('C:', 'repo', 'reading-list'),
  objective: 'Add All, Unread, and Read filters',
  model: 'qwen3.8:27b-mtp-q4_K_M',
});

describe('mission authorization envelope', () => {
  it('freezes repository, model, local-only routing, limits, and denials', () => {
    expect(envelope.repository).toBe('reading-list');
    expect(envelope.routingPolicy).toBe('local-only');
    expect(envelope.model).toBe('qwen3.8:27b-mtp-q4_K_M');
    expect(envelope.pushAuthorized).toBe(false);
    expect(envelope.networkAuthorized).toBe(false);
    expect(envelope.installAuthorized).toBe(false);
    expect(envelope.deniedCapabilities.join(' ')).toMatch(/push|network|credentials|cloud fallback/i);
    expect(missionEnvelopeDigest(envelope)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(missionEnvelopeDigest(envelope)).toBe(missionEnvelopeDigest(buildMissionEnvelope({
      workspaceRoot: path.join('C:', 'repo', 'reading-list'),
      objective: 'Add All, Unread, and Read filters',
      model: 'qwen3.8:27b-mtp-q4_K_M',
    })));
  });
});

describe('mission action policy', () => {
  it('requires review for the mission envelope itself', () => {
    const result = evaluateMissionAction({
      envelope,
      toolName: AUTHORIZE_MISSION_TOOL,
      arguments: { digest: missionEnvelopeDigest(envelope) },
    });
    expect(result.decision).toBe('require_review');
  });

  it('auto-authorizes investigation, typed checks, and host verification', () => {
    expect(evaluateMissionAction({
      envelope,
      toolName: 'search',
      arguments: { query: 'filter' },
    }).decision).toBe('auto_authorize');
    expect(evaluateMissionAction({
      envelope,
      toolName: 'read_file',
      arguments: { path: 'src/app.js', startLine: 1, endLine: 40 },
    }).decision).toBe('auto_authorize');
    expect(evaluateMissionAction({
      envelope,
      toolName: 'run_check',
      arguments: { check: 'test' },
    }).decision).toBe('auto_authorize');
    expect(evaluateMissionAction({
      envelope,
      toolName: 'run_check',
      arguments: { check: 'diff' },
    }).decision).toBe('auto_authorize');
    expect(evaluateMissionAction({
      envelope,
      toolName: 'run_check',
      arguments: { check: 'commit' },
    }).decision).toBe('auto_authorize');
    expect(evaluateMissionAction({
      envelope,
      toolName: 'host_verification',
      arguments: {},
    }).decision).toBe('auto_authorize');
  });

  it('requires human diff review for an in-scope text-file mutation with no frozen edit', () => {
    // This is the content-authorization boundary fix: path, text type, and
    // size alone never proved the CONTENT matches what the human authorized.
    // Without a matching frozen edit, every mutation must fall through to
    // human diff review — never auto-authorized from scope checks alone.
    const result = evaluateMissionAction({
      envelope,
      toolName: 'propose_file_change',
      arguments: { path: 'src/app.js', content: 'export const ok = true;\n' },
    });
    expect(result.decision).toBe('require_review');
    expect(result.normalizedPath).toBe('src/app.js');
    expect(result.contentBytes).toBeGreaterThan(0);
    expect(result.contentDigest).toMatch(/^sha256:/);
  });

  it('denies protected paths, escapes, secrets, binaries, and deletes', () => {
    expect(evaluateMissionAction({
      envelope,
      toolName: 'propose_file_change',
      arguments: { path: '.karkedikha/verification-plan.json', content: '{}' },
    }).decision).toBe('deny');
    expect(evaluateMissionAction({
      envelope,
      toolName: 'propose_file_change',
      arguments: { path: '.git/config', content: 'x' },
    }).decision).toBe('deny');
    expect(evaluateMissionAction({
      envelope,
      toolName: 'propose_file_change',
      arguments: { path: '../outside.js', content: 'x' },
    }).decision).toBe('deny');
    expect(evaluateMissionAction({
      envelope,
      toolName: 'propose_file_change',
      arguments: { path: '.env', content: 'SECRET=1' },
    }).decision).toBe('deny');
    expect(evaluateMissionAction({
      envelope,
      toolName: 'propose_file_change',
      arguments: { path: 'icon.png', content: 'not-really-png' },
    }).decision).toBe('deny');
    expect(evaluateMissionAction({
      envelope,
      toolName: 'propose_file_change',
      arguments: { path: 'src/app.js', content: 'ok', delete: true },
    }).decision).toBe('deny');
    expect(evaluateMissionAction({
      envelope,
      toolName: 'run_command',
      arguments: { command: 'npm test' },
    }).decision).toBe('deny');
  });

  it('denies oversized changes and failed-closed unmatched tools', () => {
    const oversized = evaluateMissionAction({
      envelope,
      toolName: 'propose_file_change',
      arguments: { path: 'src/app.js', content: 'x'.repeat(envelope.fileChangeLimits.maxBytesPerFile + 1) },
    });
    expect(oversized.decision).toBe('deny');
    expect(evaluateMissionAction({
      envelope,
      toolName: 'github_create_pr',
      arguments: {},
    }).decision).toBe('require_review');
  });
});

describe('content-authorization boundary: frozen-edit matching', () => {
  let workspaceRoot: string;
  const BASELINE = [
    '<html>',
    '<body>',
    '<div id="cookie-consent">',
    '  <p>We use cookies.</p>',
    '  <button>Accept</button>',
    '</div>',
    '<footer>&copy; 2025 Kha Ke Dikha. All rights reserved.</footer>',
    '</body>',
    '</html>',
    '',
  ].join('\n');

  beforeAll(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-authz-frozen-edit-'));
    fs.writeFileSync(path.join(workspaceRoot, 'base.html'), BASELINE, 'utf8');
  });
  afterAll(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function envelopeWithFrozenEdit() {
    return buildMissionEnvelope({
      workspaceRoot,
      objective: 'Change the footer copyright year from 2025 to 2026',
      model: 'qwen3.8:27b-mtp-q4_K_M',
      frozenEdits: [{ path: 'base.html', find: '&copy; 2025', replace: '&copy; 2026' }],
    });
  }

  it('auto-authorizes an exact authorized replacement', () => {
    const exact = BASELINE.replace('&copy; 2025', '&copy; 2026');
    const result = evaluateMissionAction({
      envelope: envelopeWithFrozenEdit(),
      toolName: 'propose_file_change',
      arguments: { path: 'base.html', content: exact },
    });
    expect(result.decision).toBe('auto_authorize');
    expect(result.normalizedPath).toBe('base.html');
    expect(result.contentDigest).toMatch(/^sha256:/);
  });

  it("refuses Run D's truncated replacement before commit", () => {
    // Same year fix, but the rewrite was cut short mid-file: the
    // cookie-consent banner and the closing tags are silently gone too —
    // exactly what shipped as `d966b39` and was wrongly treated as a clean
    // acceptance.
    const truncated = [
      '<html>',
      '<body>',
      '<footer>&copy; 2026 Kha Ke Dikha. All rights reserved.</footer>',
    ].join('\n');
    const result = evaluateMissionAction({
      envelope: envelopeWithFrozenEdit(),
      toolName: 'propose_file_change',
      arguments: { path: 'base.html', content: truncated },
    });
    expect(result.decision).toBe('require_review');
    expect(result.decision).not.toBe('auto_authorize');
  });

  it('does not let an unrelated deletion silently pass alongside the correct edit', () => {
    const withUnrelatedDeletion = BASELINE
      .replace('&copy; 2025', '&copy; 2026')
      .replace('<div id="cookie-consent">\n  <p>We use cookies.</p>\n  <button>Accept</button>\n</div>\n', '');
    expect(withUnrelatedDeletion).not.toBe(BASELINE.replace('&copy; 2025', '&copy; 2026'));
    const result = evaluateMissionAction({
      envelope: envelopeWithFrozenEdit(),
      toolName: 'propose_file_change',
      arguments: { path: 'base.html', content: withUnrelatedDeletion },
    });
    expect(result.decision).toBe('require_review');
    expect(result.decision).not.toBe('auto_authorize');
  });

  it('propose_text_edit: auto-authorizes a unique anchored replacement only with a still-current baseline digest', () => {
    const baselineDigest = contentDigest(BASELINE);
    const envelopeWithBaselineDigest = buildMissionEnvelope({
      workspaceRoot,
      objective: 'Change the footer copyright year from 2025 to 2026',
      model: 'qwen3.8:27b-mtp-q4_K_M',
      frozenEdits: [{ path: 'base.html', find: '&copy; 2025', replace: '&copy; 2026', baselineDigest }],
    });
    const result = evaluateMissionAction({
      envelope: envelopeWithBaselineDigest,
      toolName: 'propose_text_edit',
      arguments: { path: 'base.html', find: '&copy; 2025', replace: '&copy; 2026' },
    });
    expect(result.decision).toBe('auto_authorize');
    expect(result.normalizedPath).toBe('base.html');
    expect(result.contentDigest).toBe(contentDigest(BASELINE.replace('&copy; 2025', '&copy; 2026')));
  });

  it('propose_text_edit: refuses auto-authorize when the frozen edit carries no baseline digest, even with an exact anchor match', () => {
    // Same anchor as an authorized edit, but the frozen edit was never given
    // an authorization-time baseline digest to check against — this is the
    // "auto-authorization is allowed only when that frozen edit also
    // contains the authorization-time baseline digest" requirement.
    const envelopeNoDigest = buildMissionEnvelope({
      workspaceRoot,
      objective: 'Change the footer copyright year from 2025 to 2026',
      model: 'qwen3.8:27b-mtp-q4_K_M',
      frozenEdits: [{ path: 'base.html', find: '&copy; 2025', replace: '&copy; 2026' }],
    });
    const result = evaluateMissionAction({
      envelope: envelopeNoDigest,
      toolName: 'propose_text_edit',
      arguments: { path: 'base.html', find: '&copy; 2025', replace: '&copy; 2026' },
    });
    expect(result.decision).toBe('require_review');
    expect(result.decision).not.toBe('auto_authorize');
  });

  it('propose_text_edit: refuses auto-authorize when the frozen baseline digest is stale', () => {
    // Anchor matches exactly, but the baseline digest frozen at authorization
    // time is for content the file no longer has (or never had) — the file
    // moved since the human reviewed and froze this edit.
    const staleDigest = contentDigest('this is not the file the human reviewed');
    const envelopeStaleDigest = buildMissionEnvelope({
      workspaceRoot,
      objective: 'Change the footer copyright year from 2025 to 2026',
      model: 'qwen3.8:27b-mtp-q4_K_M',
      frozenEdits: [{ path: 'base.html', find: '&copy; 2025', replace: '&copy; 2026', baselineDigest: staleDigest }],
    });
    const result = evaluateMissionAction({
      envelope: envelopeStaleDigest,
      toolName: 'propose_text_edit',
      arguments: { path: 'base.html', find: '&copy; 2025', replace: '&copy; 2026' },
    });
    expect(result.decision).toBe('require_review');
    expect(result.decision).not.toBe('auto_authorize');
  });

  it('propose_text_edit: denies a missing anchor without proposing any mutation', () => {
    const result = evaluateMissionAction({
      envelope: envelopeWithFrozenEdit(),
      toolName: 'propose_text_edit',
      arguments: { path: 'base.html', find: 'this text does not appear anywhere', replace: 'x' },
    });
    expect(result.decision).toBe('deny');
    expect(result.contentDigest).toBeUndefined();
  });

  it('propose_text_edit: denies a duplicate (ambiguous) anchor without proposing any mutation', () => {
    const result = evaluateMissionAction({
      envelope: envelopeWithFrozenEdit(),
      toolName: 'propose_text_edit',
      // '</' occurs multiple times in BASELINE — an ambiguous anchor.
      arguments: { path: 'base.html', find: '</', replace: '< /' },
    });
    expect(result.decision).toBe('deny');
    expect(result.contentDigest).toBeUndefined();
  });

  it('propose_text_edit: leaves unrelated content byte-for-byte unchanged in the computed result', () => {
    const result = evaluateMissionAction({
      envelope: envelopeWithFrozenEdit(),
      toolName: 'propose_text_edit',
      arguments: { path: 'base.html', find: '&copy; 2025', replace: '&copy; 2026' },
    });
    expect(result.decision).toBe('require_review');
    expect(result.contentDigest).toBe(contentDigest(BASELINE.replace('&copy; 2025', '&copy; 2026')));
    // The cookie-consent banner and every other line survive untouched: the
    // digest above is for the baseline with ONLY the anchor text swapped.
  });

  it('lets a legitimately larger change use explicit review, not auto-authorize or denial', () => {
    const envelopeNoFrozenEdit = buildMissionEnvelope({
      workspaceRoot,
      objective: 'Add a dark-mode stylesheet toggle to base.html',
      model: 'qwen3.8:27b-mtp-q4_K_M',
    });
    const largerChange = `${BASELINE}<style>/* a legitimate larger change, unrelated to any frozen edit */</style>\n`;
    const result = evaluateMissionAction({
      envelope: envelopeNoFrozenEdit,
      toolName: 'propose_file_change',
      arguments: { path: 'base.html', content: largerChange },
    });
    expect(result.decision).toBe('require_review');
    expect(result.decision).not.toBe('deny');
    expect(result.decision).not.toBe('auto_authorize');
  });
});
