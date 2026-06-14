/**
 * Pure path guard used to enforce "no file writes outside the active workspace folder".
 *
 * Kept VS Code-free so it is trivially unit-testable.
 */
import * as path from 'node:path';

/**
 * Returns true if `target` resolves to a path inside (or equal to) `root`.
 * Both inputs are treated as filesystem paths. Symlinks are not resolved;
 * callers that care about symlink escape should resolve with `fs.realpath` first.
 */
export function isInsideWorkspace(root: string, target: string): boolean {
  if (!root || !target) return false;
  const normRoot = path.resolve(root);
  const normTarget = path.resolve(root, target);
  if (normTarget === normRoot) return true;
  const rel = path.relative(normRoot, normTarget);
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  // Defense-in-depth: explicit ".." segment after normalisation means escape.
  const segs = rel.split(/[\\/]/);
  return !segs.includes('..');
}

/**
 * Throws if `target` would escape `root`. Use before any `fs.writeFile`.
 */
export function assertInsideWorkspace(root: string, target: string): void {
  if (!isInsideWorkspace(root, target)) {
    throw new Error(`Reqit: refusing to write outside workspace: ${target}`);
  }
}
