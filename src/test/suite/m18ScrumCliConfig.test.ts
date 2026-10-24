import { describe, expect, it } from 'vitest';
import { resolveM18ScrumLabelOverrides } from '../../scrum/M18ScrumCliConfig';

describe('M18 Scrum CLI label configuration', () => {
  it('preserves coordinator defaults when label environment variables are absent', () => {
    expect(resolveM18ScrumLabelOverrides({})).toEqual({});
    expect(resolveM18ScrumLabelOverrides({
      OA_M18_READY_LABEL: undefined,
      OA_M18_IN_PROGRESS_LABEL: '   ',
    })).toEqual({});
  });

  it('returns only explicitly configured trimmed overrides', () => {
    expect(resolveM18ScrumLabelOverrides({
      OA_M18_READY_LABEL: ' custom-ready ',
      OA_M18_REVIEW_LABEL: 'custom-review',
    })).toEqual({
      ready: 'custom-ready',
      review: 'custom-review',
    });
  });
});
