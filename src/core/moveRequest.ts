import { createHash } from 'node:crypto';
import { parseHttpFile, type ParsedRequest } from './parser.js';

/** Swap one named HTTP section with its adjacent named section in an undoable text edit. */
export function planMoveRequest(
  source: string,
  selected: ParsedRequest,
  sectionHash: string | undefined,
  direction: 'up' | 'down',
  neighborHash?: string | undefined,
): { offset: number; length: number; text: string } | null {
  if (source.length > 1_048_576 || source.includes('\0') || !selected.name ||
      !/^[0-9a-f]{64}$/.test(sectionHash ?? '') ||
      !/^[0-9a-f]{64}$/.test(neighborHash ?? '') ||
      (direction !== 'up' && direction !== 'down')) return null;
  const requests = parseHttpFile(source).requests;
  const currentIndex = requests.findIndex((r) => r.requestLineIndex === selected.requestLineIndex);
  const current = requests[currentIndex];
  if (!current || current.name !== selected.name || current.method !== selected.method ||
      current.url !== selected.url || current.httpVersion !== selected.httpVersion ||
      current.startLine !== selected.startLine || current.endLine !== selected.endLine ||
      current.body !== selected.body ||
      JSON.stringify(current.headers) !== JSON.stringify(selected.headers) ||
      JSON.stringify(current.directives) !== JSON.stringify(selected.directives) ||
      JSON.stringify(current.tests) !== JSON.stringify(selected.tests) ||
      JSON.stringify(current.captures) !== JSON.stringify(selected.captures)) return null;

  const separators = [...source.matchAll(/^###[^\r\n]*(?:\r\n|\n|$)/gm)];
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
  const sectionIndex = separators.findIndex((match) => match.index === lineStarts[current.startLine - 1]);
  const neighborIndex = sectionIndex + (direction === 'up' ? -1 : 1);
  if (sectionIndex < 0 || neighborIndex < 0 || neighborIndex >= separators.length ||
      separators[sectionIndex][0].slice(3).trim() !== current.name) return null;
  const neighbor = requests.find((r) => lineStarts[r.startLine - 1] === separators[neighborIndex].index);
  if (!neighbor?.name || neighbor.name !== separators[neighborIndex][0].slice(3).trim()) return null;
  const selectedStart = separators[sectionIndex].index;
  const selectedEnd = separators[sectionIndex + 1]?.index ?? source.length;
  const selectedBytes = source.slice(selectedStart, selectedEnd);
  if (!selectedBytes.endsWith('\n') || createHash('sha256').update(selectedBytes).digest('hex') !== sectionHash) return null;
  const neighborStart = separators[neighborIndex].index;
  const neighborEnd = separators[neighborIndex + 1]?.index ?? source.length;
  const neighborBytes = source.slice(neighborStart, neighborEnd);
  if (!neighborBytes.endsWith('\n') || createHash('sha256').update(neighborBytes).digest('hex') !== neighborHash) return null;
  const offset = Math.min(selectedStart, neighborStart);
  const length = Math.max(selectedEnd, neighborEnd) - offset;
  // ponytail: only adjacent named sections; cross-file moves need a conflict-safe multi-file transaction.
  return { offset, length, text: direction === 'up' ? selectedBytes + neighborBytes : neighborBytes + selectedBytes };
}
