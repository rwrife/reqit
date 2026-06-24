/**
 * Pure GraphQL request helpers. No VS Code dependencies — unit-testable.
 *
 * A `.http` request is treated as GraphQL when EITHER of:
 *   - it carries a `# @graphql` (or `// @graphql`) directive, OR
 *   - it has a header `X-Request-Kind: graphql` (case-insensitive)
 *
 * Body layout (two sections separated by a blank line):
 *
 *   query GetUser($id: ID!) { user(id: $id) { id name } }
 *
 *   { "id": "42" }
 *
 * The variables block is optional. If missing, `variables` defaults to `{}`.
 * `operationName` is auto-detected from the first
 * `query|mutation|subscription Name(...)` token in the document.
 *
 * The outgoing body is JSON: `{ query, variables, operationName? }`.
 * The marker header `X-Request-Kind` is stripped from outgoing headers.
 */

import type { ParsedHeader, ParsedRequest } from './parser.js';

export interface GraphQLDoc {
  query: string;
  variables: Record<string, unknown>;
  operationName?: string;
}

export interface GraphQLBuildResult {
  /** Stringified JSON body for the outgoing HTTP request. */
  body: string;
  /** Headers with the `X-Request-Kind` marker stripped. */
  headers: ParsedHeader[];
  /** Parsed pieces, exposed for callers that want to inspect them. */
  doc: GraphQLDoc;
  /** Non-fatal warnings (e.g. malformed variables JSON). */
  diagnostics: string[];
}

const GRAPHQL_KIND_HEADER = 'x-request-kind';
const GRAPHQL_KIND_VALUE = 'graphql';
const OPERATION_RE = /\b(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/;

/** True when the request is GraphQL per the directive OR the marker header. */
export function isGraphQLRequest(req: Pick<ParsedRequest, 'directives' | 'headers'>): boolean {
  if (req.directives && Object.prototype.hasOwnProperty.call(req.directives, 'graphql')) {
    return true;
  }
  for (const h of req.headers) {
    if (h.name.toLowerCase() === GRAPHQL_KIND_HEADER && h.value.trim().toLowerCase() === GRAPHQL_KIND_VALUE) {
      return true;
    }
  }
  return false;
}

/** Strip a leading `// @graphql` / `# @graphql` directive line from a body, if any. */
function stripLeadingDirective(body: string): string {
  // Bodies don't usually carry directives, but be defensive.
  const lines = body.split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  return lines.join('\n');
}

/** Detect `operationName` from the first `query|mutation|subscription Name(...)`. */
export function detectOperationName(query: string): string | undefined {
  const m = OPERATION_RE.exec(query);
  return m ? m[2] : undefined;
}

/**
 * Split a GraphQL body into `query` + optional variables JSON.
 *
 * Algorithm: scan for the LAST blank-line boundary where the trailing chunk
 * parses as a JSON object. Everything before is the query. This tolerates
 * GraphQL documents that contain blank lines themselves while still treating
 * the trailing JSON block as variables.
 */
export function splitGraphQLBody(body: string): {
  query: string;
  variablesText: string;
} {
  const stripped = stripLeadingDirective(body);
  const lines = stripped.split('\n');

  // Find every blank-line boundary index (0-based line index of the blank line).
  const boundaries: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') boundaries.push(i);
  }

  // Try boundaries from last to first — the trailing JSON object wins.
  for (let bi = boundaries.length - 1; bi >= 0; bi--) {
    const idx = boundaries[bi];
    const tail = lines.slice(idx + 1).join('\n').trim();
    if (tail.startsWith('{') && tail.endsWith('}')) {
      try {
        const parsed = JSON.parse(tail);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const head = lines.slice(0, idx).join('\n').trim();
          return { query: head, variablesText: tail };
        }
      } catch {
        // Fall through to try the next boundary.
      }
    }
  }
  return { query: stripped.trim(), variablesText: '' };
}

/**
 * Build the outgoing JSON body and cleaned headers for a GraphQL request.
 *
 * Caller is expected to run `{{var}}` substitution on `req.body` and
 * `req.headers` BEFORE invoking this — substitution is intentionally not
 * coupled here so variables can be templated inside the document and the
 * JSON variables block alike.
 */
export function buildGraphQLRequest(req: Pick<ParsedRequest, 'headers' | 'body'>): GraphQLBuildResult {
  const diagnostics: string[] = [];
  const { query, variablesText } = splitGraphQLBody(req.body ?? '');

  let variables: Record<string, unknown> = {};
  if (variablesText !== '') {
    try {
      const parsed = JSON.parse(variablesText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        variables = parsed as Record<string, unknown>;
      } else {
        diagnostics.push('GraphQL variables block must be a JSON object; ignoring.');
      }
    } catch (err) {
      diagnostics.push(
        `GraphQL variables block is not valid JSON (${(err as Error).message}); sending variables: {}.`,
      );
    }
  }

  const operationName = detectOperationName(query);
  const doc: GraphQLDoc = { query, variables };
  if (operationName) doc.operationName = operationName;

  // Build the outgoing JSON body. Stable key order: query, variables, operationName.
  const payload: Record<string, unknown> = { query, variables };
  if (operationName) payload.operationName = operationName;

  const headers = req.headers.filter((h) => h.name.toLowerCase() !== GRAPHQL_KIND_HEADER);

  return {
    body: JSON.stringify(payload),
    headers,
    doc,
    diagnostics,
  };
}

/**
 * Shape detector for GraphQL responses. Returns true when `body` parses as
 * JSON and has `data` or `errors` at the top level.
 */
export interface GraphQLResponseShape {
  data?: unknown;
  errors?: unknown;
}

export function tryParseGraphQLResponse(
  body: string,
  contentType: string | undefined,
): GraphQLResponseShape | undefined {
  if (!body) return undefined;
  if (contentType && !/application\/(json|graphql-response\+json|.*\+json)/i.test(contentType)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (!('data' in obj) && !('errors' in obj)) return undefined;
  const out: GraphQLResponseShape = {};
  if ('data' in obj) out.data = obj.data;
  if ('errors' in obj) out.errors = obj.errors;
  return out;
}
