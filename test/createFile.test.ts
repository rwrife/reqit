import { describe, expect, it } from 'vitest';
import { sanitizeNewHttpFileName, scaffoldNewHttpFileContent } from '../src/core/createFile.js';

describe('sanitizeNewHttpFileName', () => {
  it('accepts clean base names and appends .http if missing', () => {
    expect(sanitizeNewHttpFileName('users')).toBe('users.http');
    expect(sanitizeNewHttpFileName('auth.test')).toBe('auth.test.http');
    expect(sanitizeNewHttpFileName('checkout.http')).toBe('checkout.http');
    expect(sanitizeNewHttpFileName('orders.HTTP')).toBe('orders.HTTP');
    expect(sanitizeNewHttpFileName('payments.rest')).toBe('payments.rest');
  });

  it('rejects empty, oversized, traversal, or disallowed characters', () => {
    expect(sanitizeNewHttpFileName('')).toBeNull();
    expect(sanitizeNewHttpFileName('   ')).toBeNull();
    expect(sanitizeNewHttpFileName('.http')).toBeNull();
    expect(sanitizeNewHttpFileName('../outside')).toBeNull();
    expect(sanitizeNewHttpFileName('sub/nested')).toBeNull();
    expect(sanitizeNewHttpFileName('sub\\nested')).toBeNull();
    expect(sanitizeNewHttpFileName('file?name')).toBeNull();
    expect(sanitizeNewHttpFileName('file*name')).toBeNull();
    expect(sanitizeNewHttpFileName('a'.repeat(129))).toBeNull();
  });
});

describe('scaffoldNewHttpFileContent', () => {
  it('produces valid initial .http content with sample GET request', () => {
    const content = scaffoldNewHttpFileContent();
    expect(content).toContain('### hello');
    expect(content).toContain('GET {{baseUrl}}/');
    expect(content.endsWith('\n')).toBe(true);
  });
});
