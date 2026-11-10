import { describe, expect, it } from 'vitest';
import { correctVoiceVocabulary, voiceTranscriptReview } from '../src/host/voiceTranscript';

describe('voice vocabulary hints', () => {
  it('snaps near-miss spellings of product terms to their canonical form', () => {
    expect(correctVoiceVocabulary('check my calender').text).toBe('check my Calendar');
    expect(correctVoiceVocabulary('open gmil').text).toBe('open Gmail');
    expect(correctVoiceVocabulary('show promotons').text).toBe('show Promotions');
  });

  it('never rewrites real common words that are one edit away from a term', () => {
    expect(correctVoiceVocabulary('read my emails and mail').text).toBe('read my emails and mail');
    expect(correctVoiceVocabulary('a panda picture').text).toBe('a panda picture');
  });

  // Measured 2026-11-10 (Piper speech into the bundled whisper-base.en): "Pandesh" came back as "Pandish" three times
  // and once as "Pan-dish"; the control sentences came back unchanged and must stay that way.
  it('joins a name the recognizer split with a hyphen', () => {
    expect(correctVoiceVocabulary('Pan-dish, we need an auto mode').text).toBe('Pandesh, we need an auto mode');
    expect(correctVoiceVocabulary('Pan-dish, we need an auto mode').corrections).toEqual(['Pan-dish -> Pandesh']);
    expect(correctVoiceVocabulary('Pandish. We need an auto mode').text).toBe('Pandesh. We need an auto mode');
    expect(correctVoiceVocabulary('send the e-mail to my in-box').text).toBe('send the e-mail to my in-box');
    expect(correctVoiceVocabulary('a well-known self-hosted tool').corrections).toEqual([]);
  });

  it('leaves the measured control sentences alone', () => {
    for (const sentence of [
      'The punishment should fit the crime.', 'I walked down Elm Street yesterday.', 'Panda bears eat bamboo all day.',
      'Pandas is a Python library for data frames.', 'Show me my calendar for tomorrow morning.', 'Pull llama 3.2 and qwen.',
    ]) expect(correctVoiceVocabulary(sentence).corrections, sentence).toEqual([]);
  });
});

describe('voice transcript review gate', () => {
  it('lets a read-only question go straight through', () => {
    const review = voiceTranscriptReview('How is my calendar and email looking today?');
    expect(review.required).toBe(false);
  });

  it('holds a request that asks to change mail, with the reason shown', () => {
    const review = voiceTranscriptReview('Categorize my emails by sender, grouping marketing, promotions and noise.');
    expect(review.required).toBe(true);
    expect(review.reasons.join(' ')).toContain('categorize');
  });

  it('holds a transcript whose words had to be corrected, so the person sees the change', () => {
    const review = voiceTranscriptReview('what is on my calender today');
    expect(review.required).toBe(true);
    expect(review.text).toBe('what is on my Calendar today');
    expect(review.corrections).toEqual(['calender -> Calendar']);
  });

  it('holds a single word, which is too ambiguous to act on', () => {
    expect(voiceTranscriptReview('stop').required).toBe(true);
  });
});
