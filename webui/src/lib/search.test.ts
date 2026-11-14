import { describe, it, expect } from 'vitest';
import { legacyHashToHref, validateAppSearch } from './search';

describe('search helpers', () => {
  it('legacyHashToHref', () => {
    expect(legacyHashToHref('#kanban?q=redis&note=n1')).toBe('/kanban?q=redis&note=n1');
    expect(legacyHashToHref('#view=graph&node=x&type=adr')).toBe('/graph?node=x&kind=adr');
    expect(legacyHashToHref('#tab=mcp')).toBe('/mcp');
    expect(legacyHashToHref('#bogus?q=a')).toBe('/overview?q=a');
    expect(legacyHashToHref('')).toBeNull();
    expect(legacyHashToHref('#')).toBeNull();
    expect(legacyHashToHref('#graph?session=all&kind=all')).toBe('/graph');
  });

  it('validateAppSearch drops empty/all and non-strings', () => {
    const raw = {
      q: ' ',
      kind: 'all',
      session: 'all',
      status: '',
      note: 5,
      project: 'C:\\p',
    };
    expect(validateAppSearch(raw as any)).toEqual({ project: 'C:\\p' });
  });
});
