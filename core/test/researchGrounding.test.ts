/** Re-run M9: names and links in a research answer must be found in what was retrieved. */
import { describe, expect, it } from 'vitest';
import { namedOrganisations, ungroundedClaims, urlsIn } from '../runtime/researchGrounding';

const M9_REPLY = `*   **Logistics & Supply Chain Tech:** Companies like **Delivery Hero** (currently hiring for "Senior Product Manager - Logistics") or startups in the "Smart Logistics" space.
*   **Enterprise SaaS Platforms:** Companies like **Sartorius** (industrial tech) or **Mettler-Toledo** (software-heavy systems) often look for PMs who can handle complex B2B integrations.
*   **Infrastructure & Scaling Hubs:** Companies like **IDown**, **n8n**, or **Real Digital** appear to be actively scaling their product teams in Germany.
1.  **Drafting tailored cover letters** for specific roles (e.g., at Delivery Hero or n8n).`;

describe('namedOrganisations', () => {
  it('finds the employers the re-run M9 reply named', () => {
    expect(namedOrganisations(M9_REPLY).sort()).toEqual(['Delivery Hero', 'IDown', 'Mettler-Toledo', 'Real Digital', 'Sartorius', 'n8n'].sort());
  });

  it('does not treat ordinary prose as names', () => {
    expect(namedOrganisations('Berlin is the primary hub. Highlight your data literacy. German employers value B2B experience.')).toEqual([]);
    expect(namedOrganisations('Delivery Hero is hiring a Senior Product Manager.')).toEqual(['Delivery Hero']);
  });
});

describe('ungroundedClaims', () => {
  const corpus = 'Senior Product Manager - Logistics (m/w/d) Delivery Hero Berlin ... n8n is hiring Product Managers ... Real Digital GmbH https://www.stepstone.de/jobs/product-manager';
  it('flags only what no source contains', () => {
    const r = ungroundedClaims(M9_REPLY, corpus);
    expect(r.names.sort()).toEqual(['IDown', 'Mettler-Toledo', 'Sartorius']);
  });

  it('checks links, ignoring scheme, www and trailing slash', () => {
    expect(ungroundedClaims('See https://stepstone.de/jobs/product-manager/ and https://example.com/fake-job.', corpus).urls).toEqual(['https://example.com/fake-job']);
    expect(urlsIn('[link](https://a.de/x).')).toEqual(['https://a.de/x']);
  });
});
