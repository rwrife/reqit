import { parseHttpFile } from './parser.js';

export interface LineEdit {
  startLine: number;
  endLineExclusive: number;
  newText: string;
}

export interface FavoriteTogglePlan {
  edit: LineEdit;
  isFavorite: boolean;
}

export interface AppliedFavoriteToggle {
  updatedSource: string;
  isFavorite: boolean;
  requestLineIndex: number;
}

function splitDocumentLines(source: string): string[] {
  // Respect both CRLF and LF boundaries so line indexes align with VS Code's
  // 0-indexed document line positions even in mixed-ending files.
  return source.split(/\r\n|\n/);
}

function detectDocumentEol(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

export function planFavoriteToggle(
  source: string,
  requestLineIndex: number,
): FavoriteTogglePlan | null {
  if (!Number.isSafeInteger(requestLineIndex) || requestLineIndex < 0) return null;
  const request = parseHttpFile(source).requests.find(
    (r) => r.requestLineIndex === requestLineIndex,
  );
  if (!request) return null;

  const lines = splitDocumentLines(source);
  if (requestLineIndex >= lines.length) return null;
  const eol = detectDocumentEol(source);
  // Match the parser's directive grammar: exact case-sensitive key 'favorite'.
  const directive = /^\s*(?:#|\/\/)\s*@favorite(?:\s+(.+?))?\s*$/;
  const indices: number[] = [];
  for (let i = request.startLine; i < requestLineIndex; i++) {
    if (directive.test(lines[i])) indices.push(i);
  }
  // Header-block and body directive lines remain part of the canonical
  // request contract. A preamble-only replacement would not change their
  // effective state, so refuse rather than apply a misleading edit.
  if (request.directives['favorite'] !== undefined && indices.length === 0) return null;
  for (let i = requestLineIndex + 1; i < request.endLine; i++) {
    if (lines[i].trim() === '') break;
    if (directive.test(lines[i])) return null;
  }

  const isFavorite = request.directives['favorite'] !== 'true';
  if (!isFavorite) {
    if (indices.length === 0) return null;
    return {
      edit: {
        startLine: indices[0],
        endLineExclusive: indices[indices.length - 1] + 1,
        // Preserve non-directive preamble lines interleaved with duplicate
        // favorite directives; removing only matching lines keeps the
        // request contract intact.
        newText: lines
          .slice(indices[0], indices[indices.length - 1] + 1)
          .filter((_, offset) => !indices.includes(indices[0] + offset))
          .map((line) => `${line}${eol}`)
          .join(''),
      },
      isFavorite: false,
    };
  }
  if (indices.length === 0) {
    return {
      edit: {
        startLine: requestLineIndex,
        endLineExclusive: requestLineIndex,
        newText: `# @favorite true${eol}`,
      },
      isFavorite: true,
    };
  }
  const first = indices[0];
  const last = indices[indices.length - 1];
  const replacement = lines.slice(first, last + 1).filter((_, offset) => !indices.includes(first + offset));
  return {
    edit: {
      startLine: first,
      endLineExclusive: last + 1,
      newText: [...replacement, '# @favorite true'].join(eol) + eol,
    },
    isFavorite: true,
  };
}

export function applyFavoriteToggle(
  source: string,
  requestLineIndex: number,
): AppliedFavoriteToggle | null {
  const plan = planFavoriteToggle(source, requestLineIndex);
  if (!plan) return null;
  const eol = detectDocumentEol(source);
  const lines = splitDocumentLines(source);
  const before = lines.slice(0, plan.edit.startLine).join(eol);
  const after = lines.slice(plan.edit.endLineExclusive).join(eol);
  const updatedSource = (before ? before + eol : '') + plan.edit.newText + after;
  const replacedLines = plan.edit.endLineExclusive - plan.edit.startLine;
  const insertedLines =
    plan.edit.newText === '' ? 0 : plan.edit.newText.slice(0, -eol.length).split(eol).length;
  return {
    updatedSource,
    isFavorite: plan.isFavorite,
    requestLineIndex: requestLineIndex + insertedLines - replacedLines,
  };
}
