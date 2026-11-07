import { describe, expect, it } from 'vitest';
import { deriveResearchQueries, isPublicResearchTask } from '../runtime/piAgentEngine';

// Verbatim printer mission (remediation re-run P1): "print-job" + "Find" matched the job-search rule, the turn was
// scoped to web_research only, and a fixed "Product Manager remote Germany" query was proposed for a printer request.
const PRINTER = 'Find my connected printers, identify the default printer, and prepare a one-page test document. Ask for my approval before printing it. After approval, print it through Windows and verify the print-job status. If physical output cannot be confirmed, say so.';

describe('local-device requests are not public research', () => {
  it('the printer mission keeps its local tools', () => {
    expect(isPublicResearchTask(PRINTER)).toBe(false);
    expect(isPublicResearchTask('Check the print queue on this PC')).toBe(false);
  });

  it('real job searches are still research', () => {
    expect(isPublicResearchTask('Find open Product Manager jobs in Ulm')).toBe(true);
  });

  it('a job-like request with no known role never gets a fixed query about someone else\'s search', () => {
    for (const q of deriveResearchQueries('Find current openings for nurses in Munich')) {
      expect(q).not.toMatch(/Product Manager/i);
    }
    expect(deriveResearchQueries(PRINTER).join(' ')).not.toMatch(/Product Manager/i);
  });
});
