import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '../src/core/parser.js';

describe('parseHttpFile @test directive', () => {
  it('collects @test expressions from the preamble', () => {
    const src = `# @test status === 200
# @test json.id != null
GET https://example.com/x
`;
    const { requests, diagnostics } = parseHttpFile(src);
    expect(diagnostics).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0].tests).toEqual(['status === 200', 'json.id != null']);
    expect(requests[0].directives.test).toBeUndefined();
  });

  it('collects @test expressions from trailing comments without polluting body', () => {
    const src = `POST https://example.com/x
Content-Type: application/json

{"a":1}
# @test status === 201
// @test json.a === 1
`;
    const { requests } = parseHttpFile(src);
    expect(requests).toHaveLength(1);
    expect(requests[0].tests).toEqual(['status === 201', 'json.a === 1']);
    expect(requests[0].body).toBe('{"a":1}');
  });

  it('preserves expression order across preamble and trailing positions', () => {
    const src = `# @test a
GET https://example.com/x
# @test b
# @test c
`;
    const { requests } = parseHttpFile(src);
    expect(requests[0].tests).toEqual(['a', 'b', 'c']);
  });

  it('ignores @test directives without an expression', () => {
    const src = `# @test
# @test    
GET https://example.com/
`;
    const { requests } = parseHttpFile(src);
    expect(requests[0].tests).toEqual([]);
  });

  it('keeps @auth + other directives separate from tests', () => {
    const src = `# @auth myAuth
# @test status === 200
GET https://example.com/
`;
    const { requests } = parseHttpFile(src);
    expect(requests[0].directives.auth).toBe('myAuth');
    expect(requests[0].tests).toEqual(['status === 200']);
  });
});
