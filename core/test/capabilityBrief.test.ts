/**
 * The honest capability surface.
 *
 * Two claims are tested here, and both used to be false:
 *   1. a capability the model is told about really has a tool behind it,
 *   2. an installed-but-undriven binary is never reported as operable.
 */
import { describe, expect, it } from 'vitest';
import { GovernedCapabilityRegistry, type GovernedCapabilityAdapter } from '../runtime/governedCapability';
import { buildCapabilityBrief } from '../runtime/capabilityBrief';
import { summarizeCapabilities, type InventoryItem } from '../runtime/capabilityInventory';

function adapter(id: string, tools: string[], health: 'available' | 'degraded' | 'unavailable', reason?: string): GovernedCapabilityAdapter {
  return {
    id,
    definitions: () => tools.map((name) => ({ name, description: `${name} of ${id}`, parameters: { type: 'object', properties: {} } })),
    classify: () => 'read_only',
    health: () => ({ state: health, reason, checkedAt: new Date().toISOString() }),
    run: async () => ({ status: 'succeeded', exitCode: 0, output: 'ok' }),
  };
}

describe('the capability brief', () => {
  it('names only the capabilities that own a tool, and says which tool', () => {
    const registry = new GovernedCapabilityRegistry()
      .register(adapter('browser', ['browser_open_site', 'browser_read'], 'available'))
      .register(adapter('image-studio', ['image_generate'], 'available'));
    const brief = buildCapabilityBrief({ registry, exposedCapabilityIds: ['browser', 'image-studio'] });
    expect(brief.text).toContain('browser_open_site, browser_read');
    expect(brief.text).toContain('image_generate');
    expect(brief.byCapability['browser'].state).toBe('executable');
  });

  it('says an unavailable capability is unavailable, with the reason', () => {
    const registry = new GovernedCapabilityRegistry()
      .register(adapter('browser', ['browser_open_site'], 'unavailable', 'no Edge or Chrome executable found'));
    const brief = buildCapabilityBrief({ registry, exposedCapabilityIds: ['browser'] });
    expect(brief.byCapability['browser'].state).toBe('unavailable');
    expect(brief.byCapability['browser'].reason).toBe('no Edge or Chrome executable found');
    expect(brief.text).toContain('NOT AVAILABLE');
    expect(brief.text).toContain('no Edge or Chrome executable found');
  });

  it('marks a degraded capability as degraded rather than as working', () => {
    const registry = new GovernedCapabilityRegistry()
      .register(adapter('image-studio', ['image_generate'], 'degraded', 'one generation is already running'));
    const brief = buildCapabilityBrief({ registry, exposedCapabilityIds: ['image-studio'] });
    expect(brief.byCapability['image-studio'].state).toBe('degraded');
    expect(brief.text).toContain('DEGRADED');
  });

  it('lists an installed-but-undriven tool as something Pandesh cannot drive', () => {
    const registry = new GovernedCapabilityRegistry().register(adapter('browser', ['browser_open_site'], 'available'));
    const inventory = {
      probedAt: new Date().toISOString(),
      host: { os: 'win32', cpu: 'cpu', cores: 8, ramGb: 32 },
      items: [
        { id: 'tesseract', category: 'documents', label: 'Tesseract OCR', status: 'working', detail: 'answered its version check', permission: 'approval_per_use', provides: ['ocr'], driver: 'detected_only' },
        { id: 'pdftotext', category: 'documents', label: 'Poppler pdftotext', status: 'working', detail: 'answered its version check', permission: 'approval_per_use', provides: ['pdf_text'], driver: 'tool:document_read' },
      ],
      capabilities: [],
    } as never;
    const brief = buildCapabilityBrief({ registry, exposedCapabilityIds: ['browser'], inventory });
    expect(brief.text).toContain('Tesseract OCR');
    expect(brief.text).toContain('no Pandesh workflow');
  });
});

describe('the capability inventory is honest about what a tool drives', () => {
  const item = (over: Partial<InventoryItem>): InventoryItem => ({
    id: 'x', category: 'documents', label: 'x', status: 'working', detail: '', permission: 'approval_per_use', provides: [], ...over,
  });

  it('counts a capability as available only when a governed tool drives it', () => {
    const summary = summarizeCapabilities([
      item({ id: 'tesseract', label: 'Tesseract OCR', provides: ['ocr'], driver: 'detected_only' }),
      item({ id: 'pdftotext', label: 'Poppler pdftotext', provides: ['pdf_text'], driver: 'tool:document_read' }),
    ]);
    const ocr = summary.find((entry) => entry.key === 'ocr');
    const pdfText = summary.find((entry) => entry.key === 'pdf_text');
    expect(ocr?.available).toBe(false);
    expect(ocr?.detected).toEqual(['Tesseract OCR']);
    expect(pdfText?.available).toBe(true);
    expect(pdfText?.providers).toEqual(['Poppler pdftotext']);
  });

  it('never calls a missing tool available', () => {
    const summary = summarizeCapabilities([
      item({ id: 'libreoffice', label: 'LibreOffice', status: 'missing', provides: ['office_documents'], driver: 'detected_only' }),
    ]);
    const office = summary.find((entry) => entry.key === 'office_documents');
    expect(office?.available).toBe(false);
    expect(office?.providers).toEqual([]);
    expect(office?.recommendation?.utility).toBe('libreoffice');
  });
});
