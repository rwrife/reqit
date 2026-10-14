import { describe, expect, it } from 'vitest';

import { MAX_TAG_DIRECTIVE_LENGTH, MAX_TAGS_PER_REQUEST, parseTagList } from '../src/core/tags.js';

describe('parseTagList (# @tag directive value)', () => {
  it('splits comma-separated tags, trims and lowercases each token', () => {
    expect(parseTagList(' Smoke , regression ')).toEqual(['smoke', 'regression']);
  });

  it('returns an empty list for missing or blank-only values', () => {
    expect(parseTagList(undefined)).toEqual([]);
    expect(parseTagList('')).toEqual([]);
    expect(parseTagList('  ,  ,')).toEqual([]);
  });

  it('bounds the retained token count so a hostile directive cannot amplify filter work', () => {
    const many = Array.from({ length: MAX_TAGS_PER_REQUEST * 4 }, (_, i) => `t${i}`).join(',');
    const tags = parseTagList(many);
    expect(tags).toHaveLength(MAX_TAGS_PER_REQUEST);
    expect(tags[0]).toBe('t0');
    expect(tags[MAX_TAGS_PER_REQUEST - 1]).toBe(`t${MAX_TAGS_PER_REQUEST - 1}`);
  });

  it('drops an oversized directive entirely rather than scanning unbounded token work', () => {
    expect(parseTagList('a,'.repeat(MAX_TAG_DIRECTIVE_LENGTH))).toEqual([]);
  });
});
