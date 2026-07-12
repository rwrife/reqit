import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '../src/core/parser.js';
import { exportToCurlBundle, type ExportInputFile } from '../src/core/export/curl.js';

function parseFile(source: string) {
  const { requests, diagnostics } = parseHttpFile(source);
  expect(diagnostics).toEqual([]);
  return requests;
}

describe('exportToCurlBundle', () => {
  it('emits a runnable bash script with a curl command per request', () => {
    const requests = parseFile(
      [
        'GET https://example.com/api/users',
        'Accept: application/json',
        '',
        '###',
        'POST https://example.com/api/users',
        'Content-Type: application/json',
        '',
        '{"name":"ada"}',
        '',
      ].join('\n'),
    );
    const result = exportToCurlBundle([
      { path: '.requests/users.http', kind: 'http', requests },
    ]);

    expect(result.requestsWritten).toBe(2);
    expect(result.warnings).toEqual([]);
    expect(result.script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(result.script).toContain('set -euo pipefail');
    expect(result.script).toContain('# === .requests/users.http ===');
    expect(result.script).toContain(
      `curl -H 'Accept: application/json' 'https://example.com/api/users'`,
    );
    expect(result.script).toContain(`--data-raw '{"name":"ada"}'`);
  });

  it('is deterministic — same input produces same script byte-for-byte', () => {
    const requests = parseFile('GET https://example.com/x\n');
    const a = exportToCurlBundle([{ path: 'a.http', kind: 'http', requests }]);
    const b = exportToCurlBundle([{ path: 'a.http', kind: 'http', requests }]);
    expect(a.script).toBe(b.script);
  });

  it('redacts secrets before shell quoting', () => {
    const requests = parseFile(
      [
        'GET https://example.com/api',
        'Authorization: Bearer super-secret-token',
        '',
      ].join('\n'),
    );
    const result = exportToCurlBundle(
      [{ path: 'a.http', kind: 'http', requests }],
      { redact: ['super-secret-token'] },
    );
    expect(result.script).not.toContain('super-secret-token');
    expect(result.script).toContain('***REDACTED***');
    expect(result.warnings).toEqual([]);
  });

  it('honors a custom redaction placeholder', () => {
    const requests = parseFile('GET https://example.com/?k=abc123\n');
    const result = exportToCurlBundle(
      [{ path: 'a.http', kind: 'http', requests }],
      { redact: ['abc123'], redactPlaceholder: '<SECRET>' },
    );
    expect(result.script).toContain('<SECRET>');
    expect(result.script).not.toContain('abc123');
  });

  it('ignores empty redaction entries', () => {
    const requests = parseFile('GET https://example.com/\n');
    const result = exportToCurlBundle(
      [{ path: 'a.http', kind: 'http', requests }],
      { redact: ['', '   '] }, // only truly-empty strings should be dropped
    );
    // empty string wouldn't blow up curl.ts either — the real assertion is
    // that we don't accidentally replace every gap in the string with the
    // placeholder.
    expect(result.script).not.toContain('***REDACTED***');
  });

  it('skips gRPC and WebSocket inputs with an unsupported-kind warning', () => {
    const result = exportToCurlBundle([
      { path: 'a.grpc', kind: 'grpc' },
      { path: 'a.ws', kind: 'ws' },
    ]);
    expect(result.requestsWritten).toBe(0);
    expect(result.warnings.map((w) => w.code)).toEqual([
      'unsupported-kind',
      'unsupported-kind',
    ]);
    expect(result.warnings[0].message).toMatch(/grpc/);
    expect(result.warnings[1].message).toMatch(/ws/);
    expect(result.script).toContain('# No exportable requests.');
    expect(result.script).toContain('exit 0');
  });

  it('flags files that parsed to zero requests', () => {
    const result = exportToCurlBundle([
      { path: 'blank.http', kind: 'http', requests: [] },
    ]);
    expect(result.warnings).toEqual([
      {
        path: 'blank.http',
        code: 'no-requests',
        message: 'No requests found in file.',
      },
    ]);
  });

  it('groups requests by source file with section headers', () => {
    const a = parseFile('GET https://a.example.com/\n');
    const b = parseFile('GET https://b.example.com/\n');
    const result = exportToCurlBundle([
      { path: 'a.http', kind: 'http', requests: a },
      { path: 'b.http', kind: 'http', requests: b },
    ]);
    const aIdx = result.script.indexOf('# === a.http ===');
    const bIdx = result.script.indexOf('# === b.http ===');
    expect(aIdx).toBeGreaterThan(0);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(result.script.indexOf('https://a.example.com/')).toBeGreaterThan(aIdx);
    expect(result.script.indexOf('https://a.example.com/')).toBeLessThan(bIdx);
  });

  it('collapses newlines in the optional banner so it stays a single comment', () => {
    const requests = parseFile('GET https://example.com/\n');
    const result = exportToCurlBundle(
      [{ path: 'a.http', kind: 'http', requests }],
      { banner: 'env: staging\nexported: 2026-07-12' },
    );
    expect(result.script).toContain(
      '# env: staging exported: 2026-07-12',
    );
    // Line count of the banner block: shebang, generated-by, banner, set -e, blank.
    expect(result.script.split('\n').slice(0, 5)).toEqual([
      '#!/usr/bin/env bash',
      '# Generated by Reqit — do not edit by hand.',
      '# env: staging exported: 2026-07-12',
      'set -euo pipefail',
      '',
    ]);
  });

  it('uses the request name as the label when present', () => {
    const requests = parseFile(
      ['### getUser', 'GET https://example.com/api/users/1', ''].join('\n'),
    );
    const result = exportToCurlBundle([
      { path: 'a.http', kind: 'http', requests },
    ]);
    expect(result.script).toContain('# request: getUser');
  });

  it('surfaces zod validation failures as invalid-request warnings without aborting', () => {
    // Craft a ParsedRequest with an obviously invalid URL to force
    // toUndiciRequest → zod parse to throw. We reuse parseFile shape but hand-
    // mutate — the parser itself accepts any string on the request line.
    const requests = parseFile('GET not-a-real-url\n');
    // sanity: parser produced one request
    expect(requests).toHaveLength(1);

    const good = parseFile('GET https://ok.example.com/\n');
    const result = exportToCurlBundle([
      { path: 'bad.http', kind: 'http', requests },
      { path: 'good.http', kind: 'http', requests: good },
    ]);
    expect(result.requestsWritten).toBe(1);
    expect(result.warnings.some((w) => w.code === 'invalid-request')).toBe(
      true,
    );
    expect(result.script).toContain('https://ok.example.com/');
  });
});
