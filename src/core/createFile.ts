export function sanitizeNewHttpFileName(value: string): string | null {
  const name = value.trim();
  if (name.length === 0 || name.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) return null;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return null;
  if (name.endsWith('.')) return null;
  return /\.(http|rest)$/i.test(name) ? name : `${name}.http`;
}

export function scaffoldNewHttpFileContent(): string {
  return '### hello\nGET {{baseUrl}}/\n';
}
