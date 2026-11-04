/**
 * Wish-to-Reality, grounded in the capability inventory: which deliverables this PC can genuinely produce for a
 * customer right now, what each costs to make, what it cannot do, and what a person must still do.
 *
 * An offering is "achievable" only when every capability it needs is working in the live inventory. Costs are what
 * Pandesh can actually measure or bound (no API spend: everything runs locally; electricity at the measured GPU class),
 * never projected revenue. Nothing here contacts a customer, publishes, charges or buys — the existing Wish-to-Reality
 * authorization and payment verification (core/domain/wishOrders.ts) stay in charge of anything commercial.
 */
import { checkRequirements, type CapabilityInventory, type CapabilityKey } from './capabilityInventory';

export interface ProductionOffering {
  id: string;
  name: string;
  deliverable: string;
  needs: CapabilityKey[];
  optional: CapabilityKey[];
  machineMinutes: [number, number];
  humanMinutes: [number, number];
  humanInvolvement: string[];
  limitations: string[];
  sampleTool: string | null;
}

export const OFFERINGS: ProductionOffering[] = [
  {
    id: 'promo_video', name: 'Short promotional video from a client\'s photos', deliverable: '20–60 s MP4 (1280×720 or 1080×1920) with a title card and captions, verified by FFprobe',
    needs: ['video_production'], optional: ['vision_model'], machineMinutes: [1, 6], humanMinutes: [15, 40],
    humanInvolvement: ['collect the client\'s own photos and their written permission to use them', 'check every caption for accuracy (allergens, prices and claims are never invented by Pandesh)', 'deliver the file and invoice through the existing order flow'],
    limitations: ['template-style slideshow: no filming, voice-over or licensed music', 'captions describe what is visible; they can be wrong and must be reviewed', 'quality depends entirely on the client\'s photos'],
    sampleTool: 'media_create_video',
  },
  {
    id: 'one_page_site', name: 'One-page website for a small business', deliverable: 'static HTML page with Impressum and privacy page, checked by the Wish-to-Reality quality check',
    needs: ['chat_model'], optional: ['browser_automation'], machineMinutes: [1, 3], humanMinutes: [45, 120],
    humanInvolvement: ['get the client\'s legally required Impressum details', 'the client must supply a real Datenschutzerklärung (the quality check stays strict)', 'hosting and domain are arranged by the client'],
    limitations: ['no hosting, domain, CMS or e-mail', 'web design needs the trade registration to cover it (Gewerbe Ummeldung) before it is sold'],
    sampleTool: 'wish pipeline (develop_offering)',
  },
  {
    id: 'document_digitization', name: 'Scan-to-searchable-text digitization', deliverable: 'searchable text per scanned page, plus a per-document index',
    needs: ['ocr', 'pdf_text'], optional: [], machineMinutes: [1, 10], humanMinutes: [10, 30],
    humanInvolvement: ['the client hands over the scans and consents to their processing', 'spot-check OCR accuracy on names and numbers'],
    limitations: ['OCR errors on handwriting and poor scans', 'personal documents need a data-processing agreement (AVV) under GDPR'],
    sampleTool: null,
  },
  {
    id: 'ai_imagery', name: 'AI-generated background or decoration images', deliverable: 'PNG images generated locally with ComfyUI',
    needs: ['image_generation', 'gpu'], optional: [], machineMinutes: [1, 5], humanMinutes: [10, 30],
    humanInvolvement: ['choose and approve every image', 'label AI-generated images as such where they are published'],
    limitations: ['must never be presented as photos of real food, places or people', 'model licences restrict some commercial uses'],
    sampleTool: null,
  },
  {
    id: 'office_conversion', name: 'Document conversion and formatting', deliverable: 'Word/Excel/Markdown converted to PDF or DOCX',
    needs: ['office_documents'], optional: [], machineMinutes: [1, 2], humanMinutes: [5, 15],
    humanInvolvement: ['check the converted layout'], limitations: ['complex layouts may shift'], sampleTool: null,
  },
];

/** Typical whole-PC draw while a local GPU model renders or captions (RTX 3090 class), and a German household tariff. */
const WATTS_UNDER_LOAD = 450;
const EUR_PER_KWH = 0.35;

export interface OfferingAssessment {
  offering: ProductionOffering;
  achievable: boolean;
  missing: string[];
  degraded: string[];
  electricityEur: [number, number];
}

export function assessOfferings(inventory: CapabilityInventory): OfferingAssessment[] {
  return OFFERINGS.map((offering) => {
    const req = checkRequirements(inventory, offering.needs);
    const opt = checkRequirements(inventory, offering.optional);
    const kwh = (m: number) => (WATTS_UNDER_LOAD * m) / 60 / 1000;
    return {
      offering, achievable: req.ok,
      missing: req.missing.map((m) => `${m.key}${m.recommendation ? ` (install ${m.recommendation.label}: winget ${m.recommendation.wingetId})` : ''}`),
      degraded: opt.missing.map((m) => m.key),
      electricityEur: [Math.round(kwh(offering.machineMinutes[0]) * EUR_PER_KWH * 1000) / 1000, Math.round(kwh(offering.machineMinutes[1]) * EUR_PER_KWH * 1000) / 1000],
    };
  });
}

export function renderOfferings(assessments: OfferingAssessment[]): string {
  const lines = ['Deliverables this PC can produce now (from the live capability inventory):'];
  for (const a of assessments) {
    const o = a.offering;
    const state = !a.achievable ? 'NOT YET' : o.sampleTool ? 'ACHIEVABLE' : 'TOOLS PRESENT (no Pandesh workflow yet — manual work)';
    lines.push('', `${state} — ${o.name}`);
    lines.push(`  deliverable: ${o.deliverable}`);
    if (!a.achievable) lines.push(`  missing: ${a.missing.join(', ')}`);
    if (a.degraded.length) lines.push(`  works without: ${a.degraded.join(', ')} (lower quality)`);
    lines.push(`  cost to produce: €0 API (local only); electricity about €${a.electricityEur[0].toFixed(3)}–€${a.electricityEur[1].toFixed(3)} for ${o.machineMinutes[0]}–${o.machineMinutes[1]} machine minutes`);
    lines.push(`  your time: ${o.humanMinutes[0]}–${o.humanMinutes[1]} minutes — ${o.humanInvolvement.join('; ')}`);
    lines.push(`  limitations: ${o.limitations.join('; ')}`);
    if (o.sampleTool) lines.push(`  produce a sample with: ${o.sampleTool}`);
  }
  lines.push('', 'Demand and price are not known from this PC: they need real conversations with customers. Pandesh never contacts customers, publishes, charges or buys without your explicit authorization.');
  return lines.join('\n');
}
