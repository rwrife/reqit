import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '../src/core/parser.js';
import { hashRequestSections, planDeleteRequest } from '../src/core/deleteRequest.js';

const source = '### First\r\nPOST /a\r\nX-Token: {{secret}}\r\n\r\nbody\r\n### Second\r\nGET /b\r\n';
const first = parseHttpFile(source).requests[0];
const firstHash = hashRequestSections(source, [first]).get(first.requestLineIndex)!;

describe('planDeleteRequest', () => {
  it('deletes only selected section, preserving next section bytes', () => {
    const plan = planDeleteRequest(source, first, firstHash)!;
    expect(source.slice(0, plan.offset) + source.slice(plan.offset + plan.length)).toBe('### Second\r\nGET /b\r\n');
    expect(plan).toEqual({ offset: 0, length: source.indexOf('### Second') });
  });
  it('deletes terminal section without altering preceding bytes', () => {
    const selected = parseHttpFile(source).requests[1];
    const plan = planDeleteRequest(source, selected, hashRequestSections(source, [selected]).get(selected.requestLineIndex))!;
    expect(source.slice(0, plan.offset) + source.slice(plan.offset + plan.length)).toBe(source.slice(0, source.indexOf('### Second')));
  });
  it('rejects stale selections, unnamed requests and oversized content', () => {
    expect(planDeleteRequest(source.replace('body', 'changed'), first, firstHash)).toBeNull();
    expect(planDeleteRequest(source.replace('X-Token', 'Authorization'), first, firstHash)).toBeNull();
    expect(planDeleteRequest('GET /a\n', parseHttpFile('GET /a\n').requests[0], 'x')).toBeNull();
    expect(planDeleteRequest('x'.repeat(1_048_577), first, firstHash)).toBeNull();
    expect(planDeleteRequest(source + '\0', first, firstHash)).toBeNull();
  });
  it('rejects forged, missing and malformed fingerprints', () => {
    expect(planDeleteRequest(source, first, '0'.repeat(64))).toBeNull();
    expect(planDeleteRequest(source, first, undefined)).toBeNull();
    expect(planDeleteRequest(source, first, 'ZZ')).toBeNull();
  });
  it('preserves malformed following section while deleting selected request', () => {
    const value = '### First\nGET /a\n### malformed\ninvalid\n';
    const request = parseHttpFile(value).requests[0];
    const plan = planDeleteRequest(value, request, hashRequestSections(value, [request]).get(request.requestLineIndex))!;
    expect(value.slice(0, plan.offset) + value.slice(plan.offset + plan.length)).toBe('### malformed\ninvalid\n');
  });
  it('rejects a row whose raw section changed only in a non-semantic comment', () => {
    const edited = '### First\r\n# added after the row was built\r\nPOST /a\r\nX-Token: {{secret}}\r\n\r\nbody\r\n### Second\r\nGET /b\r\n';
    const reparsed = parseHttpFile(edited).requests[0];
    // Parsed fields are identical; only raw bytes moved. A live-plan hash
    // without a captured row fingerprint must still refuse the stale row.
    expect(reparsed.name).toBe(first.name);
    expect(planDeleteRequest(edited, first, firstHash)).toBeNull();
  });
  it('fingerprints only the selected section bytes', () => {
    expect(hashRequestSections(source, [first]).get(first.requestLineIndex)).toBe(firstHash);
    expect(hashRequestSections(source.replace('body', 'body2'), [first]).get(first.requestLineIndex)).not.toBe(firstHash);
    expect(hashRequestSections(source.replace('GET /b', 'GET /c'), [first]).get(first.requestLineIndex)).toBe(firstHash);
    expect(hashRequestSections(source, [first]).size).toBe(1);
  });
});
