import { describe, expect, it } from 'vitest';
import { planAppendRequest } from '../src/core/appendRequest.js';
import { parseHttpFile } from '../src/core/parser.js';

describe('planAppendRequest', () => {
  it('appends a unique editable request to an existing .http file without touching prior bytes', () => {
    const source = '### New Request\r\nGET https://example.test/old\r\n';
    const plan = planAppendRequest(source);
    expect(plan).not.toBeNull();
    expect(plan!.text).toBe('\r\n### New Request 2\r\nGET {{baseUrl}}/\r\n');
    expect(plan!.offset).toBe(source.length);
    const result = source + plan!.text;
    expect(result.startsWith(source)).toBe(true);
    expect(parseHttpFile(result).requests.map((r) => r.name)).toEqual(['New Request', 'New Request 2']);
  });

  it('reserves names even in malformed sections that parser skips', () => {
    const source = '### New Request\nnot a request\n';
    expect(planAppendRequest(source)!.text).toContain('### New Request 2\n');
  });

  it('refuses oversized or NUL-bearing source before parsing', () => {
    expect(planAppendRequest('x'.repeat(1_048_577))).toBeNull();
    expect(planAppendRequest('GET /\0')).toBeNull();
  });

  it('creates a valid first section in an empty file and preserves LF documents', () => {
    expect(planAppendRequest('')).toEqual({ offset: 0, text: '### New Request\nGET {{baseUrl}}/\n' });
    const source = 'GET https://example.test/old\n';
    const plan = planAppendRequest(source)!;
    expect(parseHttpFile(source + plan.text).requests).toHaveLength(2);
    expect(source + plan.text).toContain('\n### New Request\nGET {{baseUrl}}/\n');
  });
});
