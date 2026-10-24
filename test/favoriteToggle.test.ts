import { describe, expect, it } from 'vitest';
import { applyFavoriteToggle, planFavoriteToggle } from '../src/core/favoriteToggle.js';
import { parseHttpFile } from '../src/core/parser.js';

const join = (...parts: string[]) => parts.join('\n');

/** Applies a plan the way a line-range WorkspaceEdit replaces text. */
function apply(source: string, requestLineIndex: number): string {
  const plan = planFavoriteToggle(source, requestLineIndex);
  expect(plan).not.toBeNull();
  const lines = source.split('\n');
  const before = lines.slice(0, plan!.edit.startLine).join('\n');
  const after = lines.slice(plan!.edit.endLineExclusive).join('\n');
  return (before ? before + '\n' : '') + plan!.edit.newText + after;
}

describe('planFavoriteToggle', () => {
  it('plans a line insert before the request line when favoriting', () => {
    const source = join('### List', 'GET https://example.test/items', '');
    const plan = planFavoriteToggle(source, 1);
    expect(plan).not.toBeNull();
    expect(plan!.isFavorite).toBe(true);
    expect(plan!.edit).toEqual({ startLine: 1, endLineExclusive: 1, newText: '# @favorite true\n' });
    const updated = apply(source, 1);
    expect(updated).toBe(join('### List', '# @favorite true', 'GET https://example.test/items', ''));
    expect(parseHttpFile(updated).requests[0].directives['favorite']).toBe('true');
  });

  it('plans removal of the directive comment line when unfavoriting, preserving siblings', () => {
    const source = join('### List', '# @name getItems', '# @favorite true', 'GET https://example.test/items', '');
    const plan = planFavoriteToggle(source, 3);
    expect(plan).not.toBeNull();
    expect(plan!.isFavorite).toBe(false);
    expect(plan!.edit).toEqual({ startLine: 2, endLineExclusive: 3, newText: '' });
    const updated = apply(source, 3);
    expect(updated).toBe(join('### List', '# @name getItems', 'GET https://example.test/items', ''));
    const parsed = parseHttpFile(updated);
    expect(parsed.requests[0].directives['favorite']).toBeUndefined();
    expect(parsed.requests[0].directives['name']).toBe('getItems');
  });

  it('plans rewriting a non-true favorite value to true', () => {
    const source = join('### Update', '# @favorite false', 'PUT https://example.test/items/1', '');
    const plan = planFavoriteToggle(source, 2);
    expect(plan!.isFavorite).toBe(true);
    expect(plan!.edit).toEqual({ startLine: 1, endLineExclusive: 2, newText: '# @favorite true\n' });
    expect(parseHttpFile(apply(source, 2)).requests[0].directives['favorite']).toBe('true');
  });

  it('removes every duplicate preamble directive so a toggle can never no-op', () => {
    const source = join(
      '### Twin',
      '# @favorite true',
      '# @auth basic',
      '# @favorite true',
      'GET https://example.test/twin',
      '',
    );
    const plan = planFavoriteToggle(source, 4);
    expect(plan!.isFavorite).toBe(false);
    const updated = apply(source, 4);
    expect(updated).toBe(join('### Twin', '# @auth basic', 'GET https://example.test/twin', ''));
    const parsed = parseHttpFile(updated);
    expect(parsed.requests[0].directives['favorite']).toBeUndefined();
    expect(parsed.requests[0].directives['auth']).toBe('basic');
  });

  it('keeps CRLF endings and only touches the targeted request', () => {
    const source = [
      '### Alpha',
      'GET https://example.test/alpha',
      '',
      '### Beta',
      '# @name betaReq',
      'POST https://example.test/beta',
      '',
      '{ "data": 1 }',
      '',
    ].join('\r\n');
    const plan = planFavoriteToggle(source, 5);
    expect(plan!.isFavorite).toBe(true);
    expect(plan!.edit.newText).toBe('# @favorite true\r\n');
    const result = applyFavoriteToggle(source, 5);
    expect(result).not.toBeNull();
    expect(result!.updatedSource).toContain('# @favorite true\r\nPOST');
    const parsed = parseHttpFile(result!.updatedSource);
    expect(parsed.requests.map((r) => r.name)).toEqual(['Alpha', 'Beta']);
    expect(parsed.requests[0].directives['favorite']).toBeUndefined();
    expect(parsed.requests[1].directives['name']).toBe('betaReq');
    expect(parsed.requests[1].body).toBe('{ "data": 1 }');
    // Follow-up edit anchors stay correct after the line insert.
    const back = applyFavoriteToggle(result!.updatedSource, result!.requestLineIndex);
    expect(back!.isFavorite).toBe(false);
    expect(back!.updatedSource).toBe(source);
  });

  it('refuses when a directive-looking line sits in the header block where a minimal edit cannot reach', () => {
    const source = join('### Sneaky', 'GET https://example.test/sneaky', '# @favorite true', '', '');
    expect(planFavoriteToggle(source, 1)).toBeNull();
    expect(applyFavoriteToggle(source, 1)).toBeNull();
  });

  it('does not treat a differently-cased directive key as the parser favorite', () => {
    const source = join('### Case', '# @Favorite true', 'GET https://example.test/case', '');
    const plan = planFavoriteToggle(source, 2);
    expect(plan!.isFavorite).toBe(true);
    expect(plan!.edit).toEqual({ startLine: 2, endLineExclusive: 2, newText: '# @favorite true\n' });
    const updated = apply(source, 2);
    expect(updated).toContain('# @Favorite true\n# @favorite true\nGET');
  });

  it('aligns edit lines to real document lines in mixed CRLF/LF files', () => {
    const source = '### A\r\nGET https://example.test/a\n\n### B\n# @favorite true\r\nGET https://example.test/b\n';
    expect(parseHttpFile(source).requests[1].directives['favorite']).toBe('true');
    const plan = planFavoriteToggle(source, 5);
    expect(plan).not.toBeNull();
    expect(plan!.isFavorite).toBe(false);
    expect(plan!.edit).toEqual({ startLine: 4, endLineExclusive: 5, newText: '' });
  });

  it('refuses indices that are not a parsed HTTP request line', () => {
    const source = join('### List', 'GET https://example.test/items', '');
    expect(planFavoriteToggle(source, 0)).toBeNull();
    expect(planFavoriteToggle(source, 99)).toBeNull();
    expect(planFavoriteToggle(source, -1)).toBeNull();
    expect(planFavoriteToggle(source, 1.5)).toBeNull();
    expect(planFavoriteToggle('', 0)).toBeNull();
  });

  it('is a reversible toggle on canonical fixtures', () => {
    for (const source of [
      join('### List', 'GET https://example.test/items', ''),
      join('### List', '# @auth basic', '# @favorite true', 'GET https://example.test/items', '', 'body'),
    ]) {
      const once = applyFavoriteToggle(source, source.split('\n').findIndex((l) => l.startsWith('GET ')));
      expect(once).not.toBeNull();
      const twice = applyFavoriteToggle(once!.updatedSource, once!.requestLineIndex);
      expect(twice).not.toBeNull();
      expect(twice!.updatedSource).toBe(source);
      expect(twice!.isFavorite).toBe(parseHttpFile(source).requests[0].directives['favorite'] === 'true');
    }
  });
});
