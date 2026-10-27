import { parseHttpFile } from './parser.js';

/** Plan a reviewable editor insertion; never write .http files outside WorkspaceEdit. */
export function planAppendRequest(source: string): { offset: number; text: string } | null {
  if (source.length > 1_048_576 || source.includes('\0')) return null;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const existing = new Set<string>();
  for (const request of parseHttpFile(source).requests) {
    if (request.name) existing.add(request.name);
  }
  for (const line of source.split(/\r\n|\n/)) {
    const match = line.match(/^\s*###\s*(.*?)\s*$/);
    if (match && match[1]) existing.add(match[1]);
  }
  let suffix = 1;
  while (existing.has(suffix === 1 ? 'New Request' : `New Request ${suffix}`)) suffix++;
  const name = suffix === 1 ? 'New Request' : `New Request ${suffix}`;
  const prefix = source.length === 0 ? '' : source.endsWith('\n') ? eol : `${eol}${eol}`;
  return { offset: source.length, text: `${prefix}### ${name}${eol}GET {{baseUrl}}/${eol}` };
}
