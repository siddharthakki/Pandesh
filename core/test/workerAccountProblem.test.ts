import { describe, expect, it } from 'vitest';
import { accountProblem } from '../runtime/kandev/devStories';

describe('worker account problems (usage limit, sign-in)', () => {
  it('recognises what Claude Code prints and quotes it, without inventing quota', () => {
    expect(accountProblem('Claude AI usage limit reached|1795400000')).toMatchObject({ kind: 'usage_limit', tag: '[kkd-dev:account-limit]' });
    expect(accountProblem("You've hit your limit · resets 9pm (Europe/Berlin)")?.kind).toBe('usage_limit');
    expect(accountProblem('5-hour limit reached ∙ resets 3am')?.kind).toBe('usage_limit');
    expect(accountProblem('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}')?.kind).toBe('usage_limit');
    expect(accountProblem('Invalid API key · Please run /login')).toMatchObject({ kind: 'signin', tag: '[kkd-dev:signin-expired]' });
    expect(accountProblem('API Error: 401 {"error":{"type":"authentication_error","message":"OAuth token has expired."}}')?.kind).toBe('signin');
    expect(accountProblem('5-hour limit reached ∙ resets 3am')!.reason).toMatch(/"5-hour limit reached ∙ resets 3am"/);
  });

  it('ordinary work that mentions limits or logins is not an account problem', () => {
    expect(accountProblem('I added rate limiting to the API client and a test for the limit.')).toBeNull();
    expect(accountProblem('Implemented the /login route and its tests; all 4 pass.')).toBeNull();
    expect(accountProblem('The usage limit setting is now configurable.')).toBeNull();
    expect(accountProblem(null)).toBeNull();
  });
});
