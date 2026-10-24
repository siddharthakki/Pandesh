import { describe, expect, it } from 'vitest';
import {
  describeLocator,
  locatorRef,
  parsePageLocator,
  resolveInspectLocator,
} from '../runtime/pageLocator';

describe('page locators', () => {
  it('keeps CSS refs as the original selector string', () => {
    expect(locatorRef({ css: '#book-input' })).toBe('#book-input');
    expect(describeLocator({ css: '#book-input' })).toBe('#book-input');
    expect(parsePageLocator({ css: '  #bill  ' })).toEqual({ css: '#bill' });
  });

  it('serializes role, label, and text locators stably', () => {
    expect(locatorRef({ role: 'button', name: 'Unread' })).toBe('{"name":"Unread","role":"button"}');
    expect(describeLocator({ role: 'button', name: 'Unread' })).toBe('button "Unread"');
    expect(describeLocator({ label: 'Book title' })).toBe('label "Book title"');
    expect(describeLocator({ text: 'All' })).toBe('text "All"');
    expect(parsePageLocator({ role: 'button', name: 'Read' })).toEqual({ role: 'button', name: 'Read' });
    expect(parsePageLocator({ label: 'Bill' })).toEqual({ label: 'Bill' });
    expect(parsePageLocator({ text: 'All' })).toEqual({ text: 'All' });
  });

  it('prefers an explicit locator over a CSS selector', () => {
    expect(resolveInspectLocator({
      selector: '#filter-unread',
      locator: { role: 'button', name: 'Unread' },
    })).toEqual({ role: 'button', name: 'Unread' });
    expect(resolveInspectLocator({ selector: '#book-input' })).toEqual({ css: '#book-input' });
    expect(resolveInspectLocator({})).toBeNull();
  });
});
