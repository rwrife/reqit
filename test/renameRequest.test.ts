import { describe, expect, it } from 'vitest';
import { planRenameRequest } from '../src/core/renameRequest.js';
import { parseHttpFile } from '../src/core/parser.js';

const source = '### First\r\nGET https://example.test/a\r\n\r\n### Second\r\nPOST https://example.test/b\r\n';
const first = parseHttpFile(source).requests[0];

describe('planRenameRequest', () => {
  it('renames only selected separator; preserves CRLF and other request bytes', () => {
    const plan = planRenameRequest(source, first, 'Renamed');
    expect(plan).toEqual({ line: 0, text: '### Renamed' });
    const updated = source.replace('### First', plan!.text);
    expect(parseHttpFile(updated).requests.map((r) => r.name)).toEqual(['Renamed', 'Second']);
    expect(updated.slice(plan!.text.length)).toBe(source.slice('### First'.length));
  });

  it('rejects stale identity and invalid or duplicate names without edits', () => {
    expect(planRenameRequest(source.replace('GET https://example.test/a', 'GET https://example.test/changed'), first, 'New')).toBeNull();
    for (const name of ['Second', ' second ', '### Injected', 'bad\nGET /', 'bad\rname', 'bad\0name', 'x'.repeat(129), '  ']) {
      expect(planRenameRequest(source, first, name)).toBeNull();
    }
  });

  it('rejects unnamed, malformed, and oversized sources', () => {
    const unnamed = 'GET https://example.test/a\n';
    expect(planRenameRequest(unnamed, parseHttpFile(unnamed).requests[0], 'Named')).toBeNull();
    expect(planRenameRequest('### First\nnot a request\n', first, 'Named')).toBeNull();
    expect(planRenameRequest(source + 'x'.repeat(1_048_577), first, 'Named')).toBeNull();
  });
});
