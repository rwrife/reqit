import { parseHttpFile, type ParsedRequest } from './parser.js';

/** Plan one undoable separator-line edit; never persist request data here. */
export function planRenameRequest(
  source: string,
  selected: ParsedRequest,
  proposedName: string,
): { line: number; text: string } | null {
  if (source.length > 1_048_576 || source.includes('\0') || typeof proposedName !== 'string') return null;
  const name = proposedName.trim();
  if (!name || name.length > 128 || [...name].some((ch) => ch === '#' || ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) return null;
  const current = parseHttpFile(source).requests.find((r) => r.requestLineIndex === selected.requestLineIndex);
  if (!current || !current.name || current.name !== selected.name ||
      current.method !== selected.method || current.url !== selected.url ||
      current.startLine !== selected.startLine) return null;
  const lines = source.split(/\r\n|\n/);
  const line = current.startLine - 1;
  if (line < 0 || !/^###(?:[^#].*)?$/.test(lines[line]) ||
      lines[line].slice(3).trim() !== current.name) return null;
  // Reserve even malformed sections: parser intentionally skips those requests.
  if (lines.some((value, index) => index !== line && /^###/.test(value) &&
      value.slice(3).trim().toLowerCase() === name.toLowerCase())) return null;
  return { line, text: `### ${name}` };
}
