import { z } from 'zod';
import { buildGraphQLRequest, isGraphQLRequest } from './graphql.js';
import type { ParsedRequest } from './parser.js';

/** Zod schema for request options sent to undici. Validate BEFORE any network IO. */
export const undiciRequestSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE']),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()),
  body: z.string().optional(),
});

export type UndiciRequestOptions = z.infer<typeof undiciRequestSchema>;

/** Convert a ParsedRequest into validated undici options. Throws ZodError on invalid input. */
export function toUndiciRequest(req: ParsedRequest): UndiciRequestOptions {
  let headersList = req.headers;
  let body = req.body;
  if (isGraphQLRequest(req)) {
    const gql = buildGraphQLRequest({ headers: req.headers, body: req.body });
    headersList = gql.headers;
    body = gql.body;
  }
  const headers: Record<string, string> = {};
  for (const h of headersList) headers[h.name] = h.value;
  // GraphQL requests always send JSON; default the header if the user didn't set one.
  if (isGraphQLRequest(req)) {
    const hasCt = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
    if (!hasCt) headers['Content-Type'] = 'application/json';
  }
  const raw: Record<string, unknown> = {
    method: req.method,
    url: req.url,
    headers,
  };
  if (body && body.length > 0) raw.body = body;
  return undiciRequestSchema.parse(raw);
}
