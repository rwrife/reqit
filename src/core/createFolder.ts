export function sanitizeNewRequestFolderName(value: string): string | null {
  const name = value.trim();
  if (name.length === 0 || name.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) return null;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return null;
  return name.endsWith('.') ? null : name;
}
