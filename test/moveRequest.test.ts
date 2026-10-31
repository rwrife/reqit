import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '../src/core/parser.js';
import { hashRequestSections } from '../src/core/deleteRequest.js';
import { planMoveRequest } from '../src/core/moveRequest.js';

const source = '### One\r\nGET /one\r\n\r\n### Two\r\nPOST /two\r\n\r\n### Three\r\nGET /three\r\n';
const requests = parseHttpFile(source).requests;
const hashes = hashRequestSections(source, requests);
const moved = (text: string, index: number, direction: 'up' | 'down', hash = hashes.get(requests[index].requestLineIndex)) => {
  const neighbor = requests[index + (direction === 'up' ? -1 : 1)];
  const edit = planMoveRequest(text, requests[index], hash, direction, neighbor && hashes.get(neighbor.requestLineIndex));
  return edit && text.slice(0, edit.offset) + edit.text + text.slice(edit.offset + edit.length);
};

describe('planMoveRequest', () => {
  it('moves named section down without changing its contents or other sections', () => {
    expect(moved(source, 0, 'down')).toBe('### Two\r\nPOST /two\r\n\r\n### One\r\nGET /one\r\n\r\n### Three\r\nGET /three\r\n');
  });
  it('moves named section up across only adjacent section', () => {
    expect(moved(source, 1, 'up')).toBe('### Two\r\nPOST /two\r\n\r\n### One\r\nGET /one\r\n\r\n### Three\r\nGET /three\r\n');
  });
  it('rejects edge moves and stale or forged fingerprints', () => {
    expect(moved(source, 0, 'up')).toBeNull();
    expect(moved(source, 2, 'down')).toBeNull();
    expect(moved(source.replace('GET /one', 'GET /changed'), 0, 'down')).toBeNull();
    expect(moved(source, 0, 'down', '0'.repeat(64))).toBeNull();
    expect(planMoveRequest(source, requests[0], undefined, 'down')).toBeNull();
    const changedNeighbor = source.replace('POST /two', 'POST /changed');
    expect(planMoveRequest(changedNeighbor, requests[0], hashes.get(requests[0].requestLineIndex), 'down', hashes.get(requests[1].requestLineIndex))).toBeNull();
    expect(planMoveRequest(source, requests[0], hashes.get(requests[0].requestLineIndex), 'down', undefined)).toBeNull();
    expect(planMoveRequest(source, requests[0], hashes.get(requests[0].requestLineIndex), 'down', '0'.repeat(64))).toBeNull();
  });
  it('refuses malformed adjacent section instead of absorbing its raw bytes', () => {
    const text = '### One\nGET /one\n### malformed\ninvalid\n### Two\nGET /two\n';
    const rows = parseHttpFile(text).requests;
    const hash = hashRequestSections(text, rows).get(rows[0].requestLineIndex);
    expect(planMoveRequest(text, rows[0], hash, 'down', hash)).toBeNull();
  });
  it('refuses terminal section without line break to avoid merging request lines', () => {
    const text = '### One\nGET /one\n### Two\nGET /two';
    const rows = parseHttpFile(text).requests;
    const hashes = hashRequestSections(text, rows);
    expect(planMoveRequest(text, rows[1], hashes.get(rows[1].requestLineIndex), 'up', hashes.get(rows[0].requestLineIndex))).toBeNull();
  });
  it('rejects unnamed rows and oversized source', () => {
    const unnamed = parseHttpFile('GET /unnamed\n').requests[0];
    expect(planMoveRequest('GET /unnamed\n', unnamed, undefined, 'down')).toBeNull();
    expect(moved('x'.repeat(1_048_577), 0, 'down')).toBeNull();
  });
});
