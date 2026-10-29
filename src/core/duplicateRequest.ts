import { parseHttpFile, type ParsedRequest } from './parser.js';

/** Plan one undoable insertion of a named HTTP section, without writing files. */
export function planDuplicateRequest(source: string, selected: ParsedRequest): { offset: number; text: string } | null {
  if (source.length > 1_048_576 || source.includes('\0') || !selected.name) return null;
  const current = parseHttpFile(source).requests.find((r) => r.requestLineIndex === selected.requestLineIndex);
  if (!current || current.name !== selected.name || current.method !== selected.method ||
      current.url !== selected.url || current.httpVersion !== selected.httpVersion ||
      current.startLine !== selected.startLine ||
      current.endLine !== selected.endLine || current.body !== selected.body ||
      JSON.stringify(current.headers) !== JSON.stringify(selected.headers) ||
      JSON.stringify(current.directives) !== JSON.stringify(selected.directives) ||
      JSON.stringify(current.tests) !== JSON.stringify(selected.tests) ||
      JSON.stringify(current.captures) !== JSON.stringify(selected.captures)) return null;
  const separators = [...source.matchAll(/^###[^\r\n]*(?:\r\n|\n|$)/gm)];
  const lineOffset = source.split('\n').slice(0, current.startLine - 1)
    .reduce((offset, line) => offset + line.length + 1, 0);
  const index = separators.findIndex((match) => match.index === lineOffset);
  if (index < 0 || separators[index][0].slice(3).trim() !== current.name) return null;
  const name = `${current.name} Copy`;
  if (name.length > 128 || [...name].some((ch) => ch === '#' || ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) return null;
  const existing = new Set(separators.map((match) => match[0].slice(3).trim().toLowerCase()));
  let suffix = 1;
  while (existing.has((suffix === 1 ? name : `${name} ${suffix}`).toLowerCase())) suffix++;
  const uniqueName = suffix === 1 ? name : `${name} ${suffix}`;
  if (uniqueName.length > 128) return null;
  const start = separators[index].index;
  const offset = separators[index + 1]?.index ?? source.length;
  const eol = separators[index][0].endsWith('\r\n') ? '\r\n' : '\n';
  const section = source.slice(start, offset);
  const firstLineEnd = separators[index][0].length;
  const prefix = offset === source.length && offset > 0 && !source.endsWith('\n') ? eol : '';
  const text = `${prefix}### ${uniqueName}${eol}${section.slice(firstLineEnd)}`;
  return { offset, text: text.endsWith('\n') ? text : `${text}${eol}` };
}
