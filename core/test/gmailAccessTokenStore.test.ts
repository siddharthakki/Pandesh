import { afterEach, describe, expect, it } from 'vitest';
import {
  clearGmailAccessToken,
  getGmailAccessToken,
  getGmailAccountEmail,
  gmailAccessTokenPresent,
  setGmailAccessToken,
} from '../runtime/connectors/gmailAccessTokenStore';

afterEach(() => {
  clearGmailAccessToken();
});

describe('gmailAccessTokenStore: in-memory push target for Desktop-minted access tokens', () => {
  it('returns null before any token is set', () => {
    expect(getGmailAccessToken()).toBeNull();
    expect(gmailAccessTokenPresent()).toBe(false);
    expect(getGmailAccountEmail()).toBeNull();
  });

  it('returns the token and account email while it has not expired', () => {
    setGmailAccessToken('tok-1', new Date(Date.now() + 60_000).toISOString(), 'me@example.com');
    expect(getGmailAccessToken()).toBe('tok-1');
    expect(gmailAccessTokenPresent()).toBe(true);
    expect(getGmailAccountEmail()).toBe('me@example.com');
  });

  it('fails closed once expired, without needing a restart to prove the mechanism', () => {
    setGmailAccessToken('tok-1', new Date(Date.now() + 1_000).toISOString(), 'me@example.com');
    const future = Date.now() + 10_000;
    expect(getGmailAccessToken(future)).toBeNull();
  });

  it('applies a small skew so a token about to expire is already treated as unusable', () => {
    setGmailAccessToken('tok-1', new Date(Date.now() + 2_000).toISOString(), 'me@example.com');
    const almostExpired = Date.now() + 1_998;
    expect(getGmailAccessToken(almostExpired)).toBeNull();
  });

  it('a fresh push replaces the prior token — this is the no-restart refresh path', () => {
    setGmailAccessToken('tok-old', new Date(Date.now() + 1_000).toISOString(), 'me@example.com');
    setGmailAccessToken('tok-new', new Date(Date.now() + 60_000).toISOString(), 'me@example.com');
    expect(getGmailAccessToken()).toBe('tok-new');
  });

  it('the account email survives briefly after token expiry, for status display', () => {
    setGmailAccessToken('tok-1', new Date(Date.now() + 1_000).toISOString(), 'me@example.com');
    expect(getGmailAccessToken(Date.now() + 10_000)).toBeNull();
    expect(getGmailAccountEmail()).toBe('me@example.com');
  });

  it('clear() removes the token and account email immediately (used on disconnect/revocation)', () => {
    setGmailAccessToken('tok-1', new Date(Date.now() + 60_000).toISOString(), 'me@example.com');
    clearGmailAccessToken();
    expect(getGmailAccessToken()).toBeNull();
    expect(getGmailAccountEmail()).toBeNull();
  });

  it('rejects an empty token, empty account email, or an unparseable expiry rather than storing garbage', () => {
    expect(() => setGmailAccessToken('', new Date(Date.now() + 60_000).toISOString(), 'me@example.com')).toThrow();
    expect(() => setGmailAccessToken('tok-1', 'not-a-date', 'me@example.com')).toThrow();
    expect(() => setGmailAccessToken('tok-1', new Date(Date.now() + 60_000).toISOString(), '')).toThrow();
  });
});
