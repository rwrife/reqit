import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only the VS Code host + socket boundaries are simulated; the activate
// path, parsers, chain core, substitution, and command wiring below are
// production code.
const host = vi.hoisted(() => ({
  registerCommand: vi.fn(),
  createTreeView: vi.fn(),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  openTextDocument: vi.fn(),
  undiciRequest: vi.fn(),
  renderResponse: vi.fn(),
  renderSseResponse: vi.fn(),
  renderGrpcInfo: vi.fn(),
  env: new Map<string, string>(),
  secrets: [] as string[],
}));

vi.mock('vscode', () => {
  class Uri {
    constructor(readonly path: string) {}
    toString() {
      return `file://${this.path}`;
    }
    static parse(value: string) {
      return new Uri(value.replace(/^file:\/\//, ''));
    }
    static joinPath(base: Uri, ...parts: string[]) {
      return new Uri([base.path, ...parts].join('/'));
    }
  }
  return {
    Uri,
    ThemeIcon: class {
      constructor(readonly id: string) {}
    },
    TreeItem: class {
      constructor(
        public label: string,
        public collapsibleState: number,
      ) {}
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    FileType: { File: 1, Directory: 2 },
    EventEmitter: class {
      event = vi.fn();
      fire = vi.fn();
    },
    RelativePattern: class {},
    commands: { registerCommand: host.registerCommand },
    window: {
      showQuickPick: vi.fn(),
      showInputBox: vi.fn(),
      showErrorMessage: host.showErrorMessage,
      showWarningMessage: host.showWarningMessage,
      showInformationMessage: host.showInformationMessage,
      createTreeView: host.createTreeView,
    },
    languages: { registerCodeLensProvider: vi.fn() },
    workspace: {
      createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {} }),
      workspaceFolders: undefined,
      openTextDocument: host.openTextDocument,
      fs: { readFile: vi.fn(), readDirectory: vi.fn(), stat: vi.fn() },
    },
    env: { clipboard: { writeText: vi.fn() } },
    StatusBarAlignment: { Right: 2 },
  };
});

vi.mock('../src/extension/envManager.js', () => ({
  EnvManager: class {
    readonly active = 'default';
    async init() {}
    async buildResolver() {
      return {
        resolve: (name: string) => host.env.get(name),
        secretValues: [...host.secrets],
      };
    }
    listSecrets() {
      return [];
    }
    dispose() {}
  },
}));

vi.mock('../src/extension/responseView.js', () => ({
  renderResponse: host.renderResponse,
  renderSseResponse: host.renderSseResponse,
  renderGrpcInfo: host.renderGrpcInfo,
}));

vi.mock('undici', () => ({
  request: (...args: unknown[]) => host.undiciRequest(...args),
}));

import { activate } from '../src/extension/extension.js';
import type { ExtensionContext } from 'vscode';

/** Minimal undici response shape the extension consumes. */
function jsonResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', ...headers },
    body: { text: async () => body },
  };
}

function docWith(source: string) {
  host.openTextDocument.mockResolvedValue({
    getText: () => source,
    uri: { toString: () => 'file:///workspace/api.http' },
  });
}

function sendHandler(): (arg?: { documentUri: string; requestLineIndex: number }) => Promise<void> {
  return host.registerCommand.mock.calls.find(([name]) => name === 'reqit.sendRequest')![1];
}

beforeEach(() => {
  vi.resetAllMocks();
  host.env = new Map<string, string>();
  host.secrets = [];
  host.createTreeView.mockReturnValue({ description: undefined, dispose: vi.fn() });
});

describe('extension send-path chaining wiring', () => {
  it('captures from a named response feed the next send; secret capture never reaches the rendered view', async () => {
    // Distinctive secret value built by concatenation so it is checkable
    // against rendered output without relying on transcript-level masking.
    const SECRET = 'sek' + 'ret-77';
    docWith(
      [
        '### Login',
        '# @name login',
        '# @capture tok: string secret = $.access_token',
        'POST {{host}}/login',
        'content-type: application/json',
        '',
        '{ "u": "{{user}}" }',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.env.set('user', 'u1');
    host.undiciRequest.mockResolvedValueOnce(
      jsonResponse(200, JSON.stringify({ access_token: SECRET, id: 42 })),
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });

    // Send 1: env-substituted, chain-clean request goes out normally.
    const [loginUrl, loginOpts] = host.undiciRequest.mock.calls[0];
    expect(loginUrl).toBe('https://api.test/login');
    expect(loginOpts.body).toBe('{ "u": "u1" }');

    // Send 2: references both the recorded response and the secret capture.
    docWith(
      [
        '### Me',
        '# @name me',
        'GET {{host}}/me?ref={{login.response.body.$.id}}&t={{tok}}',
      ].join('\n'),
    );
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{"ok":true}'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 2 });

    const [meUrl, meOpts] = host.undiciRequest.mock.calls[1];
    // The request that ACTUALLY goes out carries the real captured values.
    expect(meUrl).toBe(`https://api.test/me?ref=42&t=${SECRET}`);
    expect(meOpts).toBeDefined();

    // The rendered response view shows a redacted URL — the secret capture
    // value must not appear in derived surfaces.
    const rendered = host.renderResponse.mock.calls[1]![1] as {
      request: { url: string };
    };
    expect(rendered.request.url).not.toContain(SECRET);
    expect(rendered.request.url).toContain('[REDACTED]');
    // Non-secret chained value is fine to render.
    expect(rendered.request.url).toContain('ref=42');
  });

  it('unresolved chain references block the send with an actionable error', async () => {
    docWith(
      ['# @name login', '# @capture t = $.a', 'GET https://api.test/login', ''].join('\n'),
    );
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{"a":1}'));
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 2 });

    docWith(['GET https://api.test/x?n={{login.response.body.$.missing}}'].join('\n'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    expect(host.undiciRequest).toHaveBeenCalledTimes(1);
    const msg = host.showErrorMessage.mock.calls.map((c) => c[0]).join('\n');
    expect(msg).toContain('chain');
    expect(msg).toContain('login.response.body.$.missing');
  });

  it('a failed request records nothing; later references fail loudly instead of reading a phantom response', async () => {
    docWith(['# @name flaky', 'GET https://api.test/flaky', ''].join('\n'));
    host.undiciRequest.mockRejectedValueOnce(new Error('connection reset'));
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 1 });
    expect(host.undiciRequest).toHaveBeenCalledTimes(1);

    docWith(['GET https://api.test/x?s={{flaky.response.status}}'].join('\n'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    expect(host.undiciRequest).toHaveBeenCalledTimes(1); // blocked, nothing sent
    const msg = host.showErrorMessage.mock.calls.map((c) => c[0]).join('\n');
    // Chain-stage diagnostic specifically (not the generic env-variable
    // fallback), naming the recorded request that has no stored response.
    expect(msg).toContain('chain');
    expect(msg).toContain('flaky');
  });

  it('capture evaluation errors warn but do not block the response render', async () => {
    docWith(
      [
        '# @name bad',
        '# @capture n: number = $.name',
        'GET https://api.test/x',
        '',
      ].join('\n'),
    );
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{"name":"text"}'));
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 2 });

    expect(host.renderResponse).toHaveBeenCalledTimes(1);
    const notices = [
      ...host.showErrorMessage.mock.calls,
      ...host.showWarningMessage.mock.calls,
    ]
      .map((c) => c[0])
      .join('\n');
    expect(notices).toContain('n');
    expect(notices).toMatch(/number validation|failed number/);
  });

  it('ordinary requests without chain features behave exactly as before', async () => {
    docWith(['GET https://api.test/plain', ''].join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(204, ''));
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    expect(host.undiciRequest).toHaveBeenCalledTimes(1);
    expect(host.showErrorMessage).not.toHaveBeenCalled();
    expect(host.showWarningMessage).not.toHaveBeenCalled();
    expect(host.renderResponse).toHaveBeenCalledTimes(1);
    const rendered = host.renderResponse.mock.calls[0]![1] as { status: number };
    expect(rendered.status).toBe(204);
  });

  it('SSE reconnect re-sends the REAL wire request, never the redacted view copy', async () => {
    vi.useRealTimers();
    // Same send-then-reference flow as test 1, but the second response is
    // an SSE stream whose body ends immediately, forcing the transport's
    // reconnect path (default 3s backoff) to fire a real second request.
    const SECRET = 'sse' + 'cret-88';
    docWith(
      [
        '### Login',
        '# @name slogin',
        '# @capture stok: string secret = $.access_token',
        'POST {{host}}/login',
        'content-type: application/json',
        '',
        '{ "u": "{{user}}" }',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.env.set('user', 'u1');
    host.undiciRequest.mockResolvedValueOnce(
      jsonResponse(200, JSON.stringify({ access_token: SECRET })),
    );
    host.renderSseResponse.mockReturnValue({ update: vi.fn(), dispose: vi.fn() });
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });

    docWith(
      [
        '### Stream',
        '# @name sstream',
        'GET {{host}}/events?tok={{stok}}',
      ].join('\n'),
    );
    // First SSE response: one frame, then the body ends -> reconnect.
    const firstBody = (async function* () {
      yield 'data: one\n\n';
    })();
    host.undiciRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: firstBody,
    });
    // Reconnect response: headers resolve, body never delivers another
    // frame (the test aborts the stream instead of looping reconnects).
    const hang = () => new Promise<never>(() => {});
    const neverBody = {
      [Symbol.asyncIterator]: () => ({ next: hang }),
      setEncoding() {
        return this;
      },
    };
    host.undiciRequest.mockImplementation(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: neverBody,
    }));
    const streamPromise = sendHandler()({
      documentUri: 'file:///workspace/api.http',
      requestLineIndex: 2,
    });

    // Wait for the reconnect request (3s clamp backoff + margin).
    await vi.waitUntil(() => host.undiciRequest.mock.calls.length >= 3, { timeout: 6000 });
    const reconnectCall = host.undiciRequest.mock.calls[2] as [string, { headers: Record<string, string> }];
    // The wire request the reconnect replays must carry the REAL secret —
    // a literal `[REDACTED]` here would break the stream (issue #47 review
    // blocker B1: the redacted view copy must never feed the transport).
    expect(reconnectCall[0]).toBe(`https://api.test/events?tok=${SECRET}`);
    expect(String(reconnectCall[0]).includes('[REDACTED]')).toBe(false);

    // Stop the stream so the driver settles and later tests start clean.
    const stopCommand = host.registerCommand.mock.calls.find(
      ([name]) => name === 'reqit.stopSseStreams',
    );
    if (stopCommand) await (stopCommand[1] as () => Promise<unknown> | unknown)();
    await Promise.race([streamPromise, new Promise((r) => setTimeout(r, 1500))]);
    host.undiciRequest.mockReset();
    host.undiciRequest.mockImplementation(async () => jsonResponse(200, '{}'));
  });

  it('a secret capture substituted into the BODY is absent from the ENTIRE rendered request object', async () => {
    const SECRET = 'bod' + 'ysecret-99';
    docWith(
      [
        '### LoginBody',
        '# @name blogin',
        '# @capture btok: string secret = $.access_token',
        'POST {{host}}/login',
        'content-type: application/json',
        '',
        '{ "u": "{{user}}" }',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.env.set('user', 'u1');
    host.undiciRequest.mockResolvedValueOnce(
      jsonResponse(200, JSON.stringify({ access_token: SECRET })),
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });

    // The SECOND send puts the secret capture into the request BODY, and
    // the SAME options object that goes on the wire is what crosses the
    // render boundary (extension.ts renderRequest). The secret must be
    // provenance-tracked and scrubbed from EVERY string in that object —
    // url, header values, AND body (issue #47 review blocker B2: whole
    // object scrub, not url+headers only).
    docWith(
      ['### Pay', '# @name bpay', 'POST {{host}}/pay', '', '{"token":"{{btok}}"}'].join('\n'),
    );
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(201, '{"ok":1}'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 2 });
    const [, payOpts] = host.undiciRequest.mock.calls[1] as [string, { body: string }];
    expect(String(payOpts.body)).toContain(SECRET);

    // The object handed to the renderer must not contain the secret ANYWHERE.
    const rendered = host.renderResponse.mock.calls[1]![1] as {
      request: Record<string, unknown>;
    };
    const renderedRequestText = JSON.stringify(rendered.request);
    expect(renderedRequestText).not.toContain(SECRET);
    // Non-vacuity: the value the boundary DID sanitize is the real secret,
    // so absence can only come from redaction (fixture present on the wire).
    expect(String(payOpts.body)).toContain(SECRET);
    expect(renderedRequestText).toContain('[REDACTED]');
  });

  it('re-sending a named request REFRESHES its own captures instead of deadlocking on duplicates', async () => {
    // Interactive reality: users re-run `# @name login` after the token
    // expires. The same named exchange must update the captures IT owns
    // (issue #47 review blocker B4: owner-keyed capture recording); the
    // window store is shared across every earlier test in this file, so
    // the pre-fix first-wins rule would pin the stale token here.
    docWith(
      [
        '### Login100',
        '# @name login100',
        '# @capture l100tok: string secret = $.access_token',
        'POST {{host}}/login',
        '',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    const FIRST = 'tok-' + 'first';
    const SECOND = 'tok-' + 'second';
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, JSON.stringify({ access_token: FIRST })));
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });

    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, JSON.stringify({ access_token: SECOND })));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });
    const duplicateWarnings = host.showWarningMessage.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('duplicate capture name'));
    expect(duplicateWarnings).toEqual([]);

    // The downstream request must carry the REFRESHED token, not the stale one.
    docWith(['GET {{host}}/me?tk={{l100tok}}'].join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{}'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });
    const [meUrl] = host.undiciRequest.mock.calls.at(-1) as [string];
    expect(meUrl).toBe(`https://api.test/me?tk=${SECOND}`);
    expect(meUrl).not.toContain(FIRST);
  });

  it('a secret capture reaching the wire through GraphQL JSON-escaping is still scrubbed from the rendered copy (F1)', async () => {
    // toUndiciRequest re-serializes `# @graphql` bodies as JSON, so a
    // captured secret containing `"` crosses the wire as `sec\"ret` — the
    // raw string no longer appears, but the ESCAPED form does. The render
    // boundary must scrub both forms (issue #47 review F1).
    const SECRET = 'sek' + 'r"et-88';
    docWith(
      [
        '### GqlLogin',
        '# @name glogin',
        '# @capture gtok: string secret = $.access_token',
        'POST {{host}}/login',
        'content-type: application/json',
        '',
        '{ "u": "u1" }',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.undiciRequest.mockResolvedValueOnce(
      jsonResponse(200, JSON.stringify({ access_token: SECRET })),
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });

    docWith(
      [
        '### Gql',
        '# @name gpay',
        '# @graphql',
        'POST {{host}}/graphql',
        '',
        'query Q { f(token: "{{gtok}}") }',
      ].join('\n'),
    );
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{"data":{}}'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });

    const [, wireOpts] = host.undiciRequest.mock.calls[1] as [string, { body: string }];
    // Non-vacuity: the wire body carries the secret in SOME form (escaped).
    const wireBody = String(wireOpts.body);
    expect(wireBody.includes(SECRET) || wireBody.includes(JSON.stringify(SECRET).slice(1, -1))).toBe(true);

    const rendered = host.renderResponse.mock.calls[1]![1] as { request: unknown };
    const renderedText = JSON.stringify(rendered.request);
    expect(renderedText).not.toContain(SECRET);
    expect(renderedText).not.toContain(JSON.stringify(SECRET).slice(1, -1));
    expect(renderedText).toContain('[REDACTED]');
  });

  it('an env-SECRET expanded through a chained capture is scrubbed from the rendered copy (F1)', async () => {
    // Chained substitution: the capture VALUE is `{{inner}}`, and the env
    // stage later expands it into the real env secret. The listed capture
    // value never appears on the wire — the final env secret does — so the
    // render boundary must redact env secret values too (issue #47 F1).
    const ENV_SECRET = 'env' + '-final-99';
    docWith(
      [
        '### ChainedLogin',
        '# @name clogin',
        '# @capture ctok: string secret = $.tpl',
        'POST {{host}}/login',
        '',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.env.set('inner', ENV_SECRET);
    host.secrets.push(ENV_SECRET);
    host.undiciRequest.mockResolvedValueOnce(
      jsonResponse(200, JSON.stringify({ tpl: '{{inner}}' })),
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 3 });

    docWith(['GET {{host}}/me?tk={{ctok}}'].join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{}'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    const [wireUrl] = host.undiciRequest.mock.calls[1] as [string];
    // Non-vacuity: the env secret IS the final wire value.
    expect(wireUrl).toBe(`https://api.test/me?tk=${ENV_SECRET}`);

    const rendered = host.renderResponse.mock.calls[1]![1] as { request: unknown };
    const renderedText = JSON.stringify(rendered.request);
    expect(renderedText).not.toContain(ENV_SECRET);
    expect(renderedText).toContain('[REDACTED]');
  });

  it('two overlapping secret captures leave no prefix remnant in the rendered copy (F1)', async () => {
    // `short` is a prefix of `short-long`: redaction must apply the LONGER
    // value first, or masking the prefix exposes the tail of the long one.
    const SHORT = 'ov' + 'lap';
    const LONG = SHORT + '-longerval';
    docWith(
      [
        '### OverlapLogin',
        '# @name ologin',
        '# @capture s1: string secret = $.a',
        '# @capture s2: string secret = $.b',
        'POST {{host}}/login',
        '',
      ].join('\n'),
    );
    host.env.set('host', 'https://api.test');
    host.undiciRequest.mockResolvedValueOnce(
      jsonResponse(200, JSON.stringify({ a: SHORT, b: LONG })),
    );
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 4 });

    docWith(['GET {{host}}/x?a={{s1}}&b={{s2}}'].join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{}'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });

    const rendered = host.renderResponse.mock.calls[1]![1] as { request: unknown };
    const renderedText = JSON.stringify(rendered.request);
    expect(renderedText).not.toContain(LONG);
    expect(renderedText).not.toContain(SHORT);
    expect(renderedText).not.toContain('-longerval'); // no prefix-remnant leak
  });

  it('a flood of capture diagnostics produces a BOUNDED warning message (B5)', async () => {
    // Hostile-input bound (issue #47 review B5): diagnostics must never be
    // joined into one unbounded toast. With the parser cap (32) each
    // duplicate capture yields its own diagnostic; the adapter must render
    // a bounded summary, not a megabyte-long warning.
    const n = 32;
    const lines = ['### flood', '# @name flood'];
    for (let i = 0; i < n; i++) lines.push(`# @capture dup${i} = $.dup${i}`);
    lines.push('GET {{host}}/flood', '');
    docWith(lines.join('\n'));
    host.env.set('host', 'https://api.test');
    // Seed every capture name under a DIFFERENT owner so all 32 collide.
    const seeded = ['### seed', '# @name seeder'];
    for (let i = 0; i < n; i++) seeded.push(`# @capture dup${i} = $.dup${i}`);
    seeded.push('POST {{host}}/seed', '', '{}');
    docWith(seeded.join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, JSON.stringify({
      ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`dup${i}`, `v${i}`])),
    })));
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: n + 2 });

    docWith(lines.join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, JSON.stringify(
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`dup${i}`, `w${i}`])),
    )));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: n + 2 });

    const captureWarnings = host.showWarningMessage.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('capture issues'));
    expect(captureWarnings.length).toBeGreaterThan(0);
    for (const w of captureWarnings) {
      // Bounded output: a bounded list plus an "... and N more" summary —
      // never 32 verbatim joined diagnostics.
      expect(w.length).toBeLessThan(2000);
      if (w.includes('duplicate')) expect(w).toMatch(/\d+ more/);
    }
  });

  it('a declared-but-invalid @name warns on the activate path and records nothing', async () => {
    docWith(['# @name 1bad-name', 'GET https://api.test/x', ''].join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{"a":1}'));
    activate({ subscriptions: [] } as unknown as ExtensionContext);
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 1 });

    // The request itself still goes out (the name is not on the wire).
    expect(host.undiciRequest).toHaveBeenCalledTimes(1);
    const warnings = host.showWarningMessage.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnings).toContain('1bad-name');

    // ...and nothing was recorded for it. `1bad-name` is not a legal chain
    // identifier, so a `{{1bad-name.response.status}}` reference is not
    // chain-shaped and falls through to the ENV stage: it must fail as an
    // UNRESOLVED VARIABLE (env wording), never resolve and never produce a
    // chain-stage diagnostic — proving no chain record exists for the name.
    docWith(['GET https://api.test/y?n={{1bad-name.response.status}}'].join('\n'));
    host.undiciRequest.mockResolvedValueOnce(jsonResponse(200, '{}'));
    await sendHandler()({ documentUri: 'file:///workspace/api.http', requestLineIndex: 0 });
    expect(host.undiciRequest).toHaveBeenCalledTimes(1); // blocked by env stage
    const errors = host.showErrorMessage.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errors).toContain('unresolved variables');
    expect(errors).not.toContain('unresolved chain references');
  });
});
