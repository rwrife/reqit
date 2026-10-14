/** Local, presentation-only comma-separated `# @tag` directive. */
export const MAX_TAGS_PER_REQUEST = 16;
export const MAX_TAG_DIRECTIVE_LENGTH = 512;

export function parseTagList(source: string | undefined): string[] {
  if (!source || source.length > MAX_TAG_DIRECTIVE_LENGTH) return [];
  // ponytail: one @tag line per HTTP request; repeatable directives need parser schema work.
  return source
    .split(',', MAX_TAGS_PER_REQUEST)
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
}
