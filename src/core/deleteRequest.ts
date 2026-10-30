import { parseHttpFile, type ParsedRequest } from './parser.js';
import { createHash } from 'node:crypto';

/**
 * Byte range [offset, offset+length) of the raw section a parsed request row
 * refers to: its `### name` separator line through just before the next
 * separator (or EOF). These are exactly the bytes a deletion would remove.
 */
function sectionRange(source: string, selected: ParsedRequest): { offset: number; length: number } | null {
  if (source.length > 1_048_576 || source.includes('\0') || !selected.name) return null;
  const separators = [...source.matchAll(/^###[^\r\n]*(?:\r\n|\n|$)/gm)];
  const lineOffset = source.split('\n').slice(0, selected.startLine - 1)
    .reduce((offset, line) => offset + line.length + 1, 0);
  const index = separators.findIndex((match) => match.index === lineOffset);
  if (index < 0 || separators[index][0].slice(3).trim() !== selected.name) return null;
  const offset = separators[index].index;
  // Stop at the next separator, even a malformed one the parser skipped, so
  // deletion never absorbs a following section's bytes.
  const end = separators[index + 1]?.index ?? source.length;
  return { offset, length: end - offset };
}

/**
 * SHA-256 fingerprint of every request's raw section bytes, keyed by
 * `requestLineIndex`. Explorer rows capture theirs at build time so ANY edit
 * inside a section — even a non-semantic comment the parser ignores —
 * invalidates a stale destructive plan. One regex pass; no per-row rescans.
 */
export function hashRequestSections(source: string, requests: ParsedRequest[]): Map<number, string> {
  const hashes = new Map<number, string>();
  if (source.length > 1_048_576 || source.includes('\0')) return hashes;
  const separators = [...source.matchAll(/^###[^\r\n]*(?:\r\n|\n|$)/gm)];
  if (separators.length === 0) return hashes;
  const separatorIndexByOffset = new Map(separators.map((match, index) => [match.index, index]));
  // line -> byte offset of line starts, one linear pass.
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineStarts.push(i + 1);
  }
  for (const request of requests) {
    if (!request.name) continue;
    const lineOffset = lineStarts[request.startLine - 1];
    if (lineOffset === undefined) continue;
    // Separator matches are line-anchored, so the offset map is exact.
    const index = separatorIndexByOffset.get(lineOffset);
    if (index === undefined || separators[index][0].slice(3).trim() !== request.name) continue;
    const offset = separators[index].index;
    const end = separators[index + 1]?.index ?? source.length;
    hashes.set(request.requestLineIndex,
      createHash('sha256').update(source.slice(offset, end)).digest('hex'));
  }
  return hashes;
}

/** Plan removal of one named HTTP section, without writing files. */
export function planDeleteRequest(
  source: string,
  selected: ParsedRequest,
  sectionHash: string | undefined,
): { offset: number; length: number } | null {
  if (typeof sectionHash !== 'string' || !/^[0-9a-f]{64}$/.test(sectionHash)) return null;
  const current = parseHttpFile(source).requests.find((r) => r.requestLineIndex === selected.requestLineIndex);
  if (!current || current.name !== selected.name || current.method !== selected.method ||
      current.url !== selected.url || current.httpVersion !== selected.httpVersion ||
      current.startLine !== selected.startLine ||
      current.endLine !== selected.endLine || current.body !== selected.body ||
      JSON.stringify(current.headers) !== JSON.stringify(selected.headers) ||
      JSON.stringify(current.directives) !== JSON.stringify(selected.directives) ||
      JSON.stringify(current.tests) !== JSON.stringify(selected.tests) ||
      JSON.stringify(current.captures) !== JSON.stringify(selected.captures)) return null;
  const range = sectionRange(source, current);
  if (!range) return null;
  // Raw-byte fingerprint of the exact deletion span must match the row's
  // captured hash; parsed-field equality alone would miss comment/blank edits.
  const live = createHash('sha256').update(source.slice(range.offset, range.offset + range.length)).digest('hex');
  if (live !== sectionHash) return null;
  return range;
}
