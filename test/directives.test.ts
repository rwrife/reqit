import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '../src/core/parser.js';

describe('parseHttpFile — directives', () => {
  it('extracts `# @auth <name>` directive into directives map', () => {
    const src = `# @auth github
GET https://api.test/me
`;
    const { requests, diagnostics } = parseHttpFile(src);
    expect(diagnostics).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0].directives).toEqual({ auth: 'github' });
  });

  it('supports `// @key value` form and multiple directives', () => {
    const src = `// @auth admin
// @name list-users
GET https://api.test/users
`;
    const { requests } = parseHttpFile(src);
    expect(requests[0].directives).toEqual({ auth: 'admin', name: 'list-users' });
  });

  it('captures bare directive with no value as empty string', () => {
    const src = `# @debug
GET https://api.test/
`;
    const { requests } = parseHttpFile(src);
    expect(requests[0].directives).toEqual({ debug: '' });
  });

  it('directives are scoped per section (### separator resets)', () => {
    const src = `### first
# @auth a
GET https://x.test/1

### second
GET https://x.test/2
`;
    const { requests } = parseHttpFile(src);
    expect(requests).toHaveLength(2);
    expect(requests[0].directives).toEqual({ auth: 'a' });
    expect(requests[1].directives).toEqual({});
  });

  it('non-directive comments are still ignored', () => {
    const src = `# just a note
# @auth github
GET https://api.test/
`;
    const { requests } = parseHttpFile(src);
    expect(requests[0].directives).toEqual({ auth: 'github' });
  });
});
