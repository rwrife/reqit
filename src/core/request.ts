import { z } from 'zod';
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
  const headers: Record<string, string> = {};
  for (const h of req.headers) headers[h.name] = h.value;
  const raw: Record<string, unknown> = {
    method: req.method,
    url: req.url,
    headers,
  };
  if (req.body && req.body.length > 0) raw.body = req.body;
  return undiciRequestSchema.parse(raw);
}
