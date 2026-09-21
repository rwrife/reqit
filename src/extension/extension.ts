import * as vscode from 'vscode';
import { HTTP_METHODS, parseHttpFile, type ParsedRequest } from '../core/parser.js';
import { toUndiciRequest } from '../core/request.js';
import { substituteRequest } from '../core/substitute.js';
import {
  createChainStore,
  isValidChainName,
  prepareChainSend,
  recordChainExchange,
  validateRequestNames,
} from '../core/chain/index.js';
import {
  renderResponse,
  renderGrpcInfo,
  renderSseResponse,
  type SseRenderEvent,
  type SseRenderState,
} from './responseView.js';
import {
  buildSseTranscriptFileName,
  closeOnAbort,
  isSseResponse,
  pickSseTranscriptRecord,
  runSseTransportWithReconnect,
  sanitizeSseErrorText,
  serializeSseTranscript,
  sseOptionsFromDirectives,
  SseStreamRegistry,
  type SseStreamHandle,
  type SseTranscriptRecord,
} from '../core/sse/index.js';
import { requestToCurl } from '../core/curl.js';
import { initWorkspace } from './initWorkspace.js';
import { importFromCurlCommand } from './importCurl.js';
import { importFromPostmanCommand } from './importPostman.js';
import { importFromOpenApiCommand } from './importOpenapi.js';
import {
  REQUEST_NAME_SEARCH_MAX_LENGTH,
  RequestsTreeProvider,
} from './requestsTree.js';
import { EnvManager } from './envManager.js';
import { buildGrpcCodeLenses, parseGrpcFile } from '../core/grpc.js';

interface LastSseTranscript {
  content: string;
  suggestedFileName: string;
  eventCount: number;
}

let lastSseTranscript: LastSseTranscript | undefined;

/**
 * Live SSE sessions owned by this extension host. The `Stop stream`
 * command aborts every session here; each session deregisters itself when
 * its driver finishes naturally.
 */
const sseStreams = new SseStreamRegistry();

/**
 * Per-extension-host request-chaining store (issue #47 send-path slice).
 * Named requests, responses, and captures accumulate across sends for the
 * life of the window session — in memory only, never persisted. Reloading
 * the window clears it; `Run file` orchestration (a later slice) will
 * snapshot/reset it per file run.
 */
const chainStore = createChainStore();

/**
 * Shared redaction boundary (pure core, issue #47): every derived surface —
 * rendered echoes, recorded store bodies, clipboard/cURL exports, error
 * toasts — scrubs secret values with this ONE implementation so adapters
 * cannot fork the behavior. The CLI adapter reuses it directly.
 */
import { redactSecretText } from '../core/chain/redact.js';

// Re-export for the (test-visible) adapter surface; the implementation lives
// in the pure core so the CLI adapter shares identical behavior.
export { redactSecretText };

/**
 * Surface capture recording diagnostics (invalid directives, failed type
 * validation, duplicate names) as a warning. Capture problems never block
 * the response render — the exchange itself succeeded.
 *
 * Bounded output (issue #47 review B5): hostile files can declare many
 * capture directives, each yielding a diagnostic. Only the first few are
 * shown verbatim; the remainder collapses into an "and N more" summary so
 * the toast never grows with input size.
 */
const CAPTURE_WARNING_SHOWN = 3;

function reportCaptureDiagnostics(diagnostics: readonly string[]): void {
  if (diagnostics.length === 0) return;
  // Per-diagnostic length bound (issue #47 review G): a hostile directive
  // text can be embedded verbatim in an error string, so the count bound
  // alone is not a size bound. Each shown diagnostic is truncated hard.
  const CAPTURE_DIAG_MAX = 200;
  const clip = (d: string): string =>
    d.length <= CAPTURE_DIAG_MAX ? d : `${d.slice(0, CAPTURE_DIAG_MAX - 1)}…`;
  const shown = diagnostics.slice(0, CAPTURE_WARNING_SHOWN).map(clip).join('; ');
  const rest = diagnostics.length - CAPTURE_WARNING_SHOWN;
  const summary = rest > 0 ? `${shown}; and ${rest} more (see capture directives)` : shown;
  void vscode.window.showWarningMessage(`Reqit: capture issues — ${summary}`);
}

/** Stop all live SSE streams. Returns how many streams were stopped. */
function stopSseStreams(): number {
  return sseStreams.stopActive();
}

export function activate(context: vscode.ExtensionContext): void {
  const treeProvider = new RequestsTreeProvider();
  const treeView = vscode.window.createTreeView('reqit.requests', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);
  let filterPickerGeneration = 0;
  let nameSearchPromptGeneration = 0;

  const updateRequestsTreeDescription = (): void => {
    const parts: string[] = [];
    const methodFilter = treeProvider.getMethodFilter();
    if (methodFilter) parts.push(`Method: ${methodFilter}`);
    if (treeProvider.hasNameSearchFilter()) parts.push('Name search active');
    treeView.description = parts.length > 0 ? parts.join(' • ') : undefined;
  };

  const envManager = new EnvManager(context);
  context.subscriptions.push(envManager);
  void envManager.init();

  // Watch .requests/ for changes to keep the tree fresh, without polling.
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '.requests/**/*.{http,grpc}'),
    );
    watcher.onDidCreate(() => treeProvider.refresh());
    watcher.onDidChange(() => treeProvider.refresh());
    watcher.onDidDelete(() => treeProvider.refresh());
    context.subscriptions.push(watcher);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('reqit.initWorkspace', async () => {
      await initWorkspace();
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('reqit.importFromCurl', async () => {
      await importFromCurlCommand();
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('reqit.importFromPostman', async () => {
      await importFromPostmanCommand();
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('reqit.importFromOpenApi', async () => {
      await importFromOpenApiCommand();
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('reqit.refreshRequests', () => treeProvider.refresh()),
    vscode.commands.registerCommand('reqit.filterRequests', async () => {
      const generation = ++filterPickerGeneration;
      const choices = [
        { label: 'All methods', method: undefined as string | undefined },
        ...[...HTTP_METHODS, 'GRPC'].map((method) => ({ label: method, method })),
      ];
      const picked = await vscode.window.showQuickPick(choices, {
        title: 'Filter requests by method',
        placeHolder: 'Filters requests inside files; folders and files remain visible',
        canPickMany: false,
      });
      if (generation !== filterPickerGeneration || !picked || !choices.includes(picked)) return;
      treeProvider.setMethodFilter(picked.method);
      updateRequestsTreeDescription();
    }),
    vscode.commands.registerCommand('reqit.searchRequestsByName', async () => {
      const generation = ++nameSearchPromptGeneration;
      const input = await vscode.window.showInputBox({
        title: 'Search requests by name',
        placeHolder: 'Case-insensitive literal match on ### request names (empty clears)',
        validateInput: (value: string) =>
          value.length > REQUEST_NAME_SEARCH_MAX_LENGTH
            ? `Name search must be ${REQUEST_NAME_SEARCH_MAX_LENGTH} characters or fewer.`
            : undefined,
      });
      if (generation !== nameSearchPromptGeneration || input === undefined) return;
      treeProvider.setNameFilter(input);
      updateRequestsTreeDescription();
    }),
    vscode.commands.registerCommand('reqit.selectEnv', () => envManager.pickEnv()),
    vscode.commands.registerCommand('reqit.saveSseTranscript', () => saveLastSseTranscript()),
    vscode.commands.registerCommand('reqit.stopSseStream', async () => {
      const stopped = stopSseStreams();
      if (stopped === 0) {
        void vscode.window.showInformationMessage('Reqit: no active SSE stream to stop.');
        return;
      }
      void vscode.window.showInformationMessage(
        `Reqit: stopped ${stopped} SSE stream${stopped === 1 ? '' : 's'}.`,
      );
    }),
    vscode.commands.registerCommand(
      'reqit.copyAsCurl',
      async (arg?: { documentUri: string; requestLineIndex: number; revealSecrets?: boolean }) => {
        if (!arg) {
          vscode.window.showWarningMessage('Reqit: use the Copy as curl codelens.');
          return;
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(arg.documentUri));
        const parsed = parseHttpFile(doc.getText());
        const req = parsed.requests.find((r) => r.requestLineIndex === arg.requestLineIndex);
        if (!req) {
          vscode.window.showErrorMessage('Reqit: request not found at codelens position.');
          return;
        }
        // Chain stage FIRST, mirroring runRequest (issue #47 review D):
        // the clipboard must reproduce the request Send Request WOULD
        // issue — chain refs included — and consume the same secret
        // provenance so the export path cannot bypass redaction.
        const chained = prepareChainSend(
          { url: req.url, headers: req.headers, body: req.body },
          chainStore,
        );
        if (chained.diagnostics.length > 0) {
          const refs = [...new Set(chained.diagnostics.map((d) => d.variable))].join(', ');
          vscode.window.showErrorMessage(
            `Reqit: unresolved chain references: ${refs} — run the source request first.`,
          );
          return;
        }
        const { resolve, secretValues } = await envManager.buildResolver();
        const substituted = substituteRequest(
          { url: chained.url, headers: chained.headers, body: chained.body },
          { resolve },
        );
        if (substituted.diagnostics.length > 0) {
          const names = [...new Set(substituted.diagnostics.map((d) => d.variable))].join(', ');
          vscode.window.showErrorMessage(
            `Reqit: unresolved variables (${envManager.active}): ${names}`,
          );
          return;
        }
        // Same taint closure as runRequest: env-injected expansions of
        // secret text join the clipboard redaction set.
        const copySecrets = [...chained.resolvedSecrets, ...secretValues];
        for (let pass = 0; pass < 4; pass++) {
          let grew = false;
          for (const inj of substituted.injected) {
            if (
              inj.value !== '' &&
              !copySecrets.includes(inj.value) &&
              copySecrets.some((sec) => sec.includes(inj.reference))
            ) {
              copySecrets.push(inj.value);
              grew = true;
            }
          }
          if (!grew) break;
        }
        let opts;
        try {
          opts = toUndiciRequest({
            ...req,
            url: substituted.url,
            headers: substituted.headers,
            body: substituted.body,
          });
        } catch (err) {
          vscode.window.showErrorMessage(
            `Reqit: invalid request — ${redactSecretText(
              sanitizeSseErrorText((err as Error).message ?? String(err)),
              copySecrets,
            )}`,
          );
          return;
        }
        const cmd = requestToCurl(opts, {
          // Chain secret captures AND env secrets (with taint closure) are
          // redaction inputs on reveal=false copies (issue #47 review D).
          redact: arg.revealSecrets ? [] : copySecrets,
        });
        await vscode.env.clipboard.writeText(cmd);
        vscode.window.showInformationMessage(
          arg.revealSecrets
            ? 'Reqit: curl copied (with secrets — handle with care).'
            : 'Reqit: curl copied (secrets redacted).',
        );
      },
    ),
    vscode.commands.registerCommand('reqit.setSecret', async () => {
      const secrets = envManager.listSecrets();
      if (secrets.length === 0) {
        vscode.window.showInformationMessage(
          'Reqit: no secrets declared in .http-env.json (use { "$secret": true }).',
        );
        return;
      }
      const pick = await vscode.window.showQuickPick(
        secrets.map((s) => ({ label: `${s.env}.${s.name}`, env: s.env, name: s.name })),
        { placeHolder: 'Select secret to set' },
      );
      if (!pick) return;
      await envManager.setSecret(pick.env, pick.name);
    }),
    vscode.commands.registerCommand(
      'reqit.sendRequest',
      async (arg?: { documentUri: string; requestLineIndex: number }) => {
        if (!arg) {
          vscode.window.showWarningMessage('Reqit: use the Send Request codelens.');
          return;
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(arg.documentUri));
        const parsed = parseHttpFile(doc.getText());
        const req = parsed.requests.find((r) => r.requestLineIndex === arg.requestLineIndex);
        if (!req) {
          vscode.window.showErrorMessage('Reqit: request not found at codelens position.');
          return;
        }
        // Enforce the documented per-file name uniqueness BEFORE recording
        // can let two source requests fight over one store name (issue #47
        // review E): duplicates block the send with an actionable error.
        // Only VALID names can collide in the store (invalid ones are
        // never recorded and already warn per-send), so the duplicate scan
        // excludes them and keeps the invalid-name warning behavior.
        const allNames = parsed.requests
          .map((r) => r.directives['name'])
          .filter((n): n is string => n !== undefined && isValidChainName(n));
        const dupDiags = validateRequestNames(allNames);
        if (dupDiags.length > 0) {
          vscode.window.showErrorMessage(
            `Reqit: cannot run chained file — ${dupDiags.slice(0, 3).join('; ')}${dupDiags.length > 3 ? `; and ${dupDiags.length - 3} more` : ''}`,
          );
          return;
        }
        // Surface parser-level bounds (capture-limit truncation) for THIS
        // request instead of silently dropping directives (issue #47 F).
        const parseDiags = parsed.diagnostics.filter(
          (d) => d.line === arg.requestLineIndex && d.message.includes('capture limit'),
        );
        if (parseDiags.length > 0) {
          vscode.window.showWarningMessage(
            `Reqit: ${parseDiags.map((d) => d.message).join('; ')}`,
          );
        }
        await runRequest(context, req, envManager);
      },
    ),
    vscode.commands.registerCommand(
      'reqit.sendGrpcRequest',
      async (arg?: { documentUri: string; requestLineIndex: number }) => {
        if (!arg) {
          vscode.window.showWarningMessage('Reqit: use the Send Request codelens on a .grpc file.');
          return;
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(arg.documentUri));
        const { requests, diagnostics } = parseGrpcFile(doc.getText());
        const req = requests.find((r) => r.requestLineIndex === arg.requestLineIndex);
        if (!req) {
          const diag = diagnostics.find((d) => d.line <= arg.requestLineIndex);
          const detail = diag ? ` (${diag.message})` : '';
          vscode.window.showErrorMessage(
            `Reqit: gRPC request not found at codelens position${detail}.`,
          );
          return;
        }
        // Wire runner (server-reflection + mTLS via @grpc/grpc-js) ships in a
        // follow-up PR under issue #24. Until then we render the parsed
        // request into the response panel so users can verify the parser did
        // the right thing and copy things by hand if they need to.
        renderGrpcInfo(context, { request: req });
      },
    ),
    vscode.languages.registerCodeLensProvider({ language: 'http' }, new HttpCodeLensProvider()),
    vscode.languages.registerCodeLensProvider({ language: 'grpc' }, new GrpcCodeLensProvider()),
  );
}

export function deactivate(): void {
  // Abort every live SSE session so no stream outlives the host.
  sseStreams.abortAll();
}

class HttpCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const { requests } = parseHttpFile(document.getText());
    const lenses: vscode.CodeLens[] = [];
    for (const r of requests) {
      const range = new vscode.Range(r.requestLineIndex, 0, r.requestLineIndex, 0);
      const args = [{ documentUri: document.uri.toString(), requestLineIndex: r.requestLineIndex }];
      lenses.push(
        new vscode.CodeLens(range, {
          title: '▶ Send Request',
          command: 'reqit.sendRequest',
          arguments: args,
        }),
        new vscode.CodeLens(range, {
          title: '$(clippy) Copy as curl',
          command: 'reqit.copyAsCurl',
          arguments: args,
        }),
      );
    }
    return lenses;
  }
}

class GrpcCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const parsed = parseGrpcFile(document.getText());
    const specs = buildGrpcCodeLenses(parsed, document.uri.toString());
    return specs.map(
      (s) =>
        new vscode.CodeLens(new vscode.Range(s.line, 0, s.line, 0), {
          title: s.title,
          command: s.command,
          arguments: [s.arg],
        }),
    );
  }
}

function buildLastSseTranscript(
  records: readonly SseTranscriptRecord[],
): LastSseTranscript | undefined {
  if (records.length === 0) return undefined;
  const firstTimestamp = records[0]?.timestampMs ?? Date.now();
  return {
    content: serializeSseTranscript(records),
    suggestedFileName: buildSseTranscriptFileName(firstTimestamp),
    eventCount: records.length,
  };
}

async function saveSseTranscript(transcript: LastSseTranscript): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  const defaultUri = workspace
    ? vscode.Uri.joinPath(workspace.uri, '.requests', '.history', transcript.suggestedFileName)
    : undefined;

  const target = await vscode.window.showSaveDialog({
    saveLabel: 'Save SSE transcript',
    filters: { JSONL: ['jsonl'] },
    defaultUri,
  });
  if (!target) return;

  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(transcript.content));
  vscode.window.showInformationMessage(
    `Reqit: saved SSE transcript (${transcript.eventCount} events).`,
  );
}

async function saveLastSseTranscript(): Promise<void> {
  const transcript = lastSseTranscript;
  if (!transcript || !transcript.content) {
    vscode.window.showInformationMessage('Reqit: no SSE transcript captured yet.');
    return;
  }

  try {
    await saveSseTranscript(transcript);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    vscode.window.showErrorMessage(`Reqit: failed to save SSE transcript — ${message}`);
  }
}

async function runRequest(
  context: vscode.ExtensionContext,
  req: ParsedRequest,
  envManager: EnvManager,
): Promise<void> {
  // Chain stage FIRST: resolve `{{name.response…}}` / capture references
  // against the run store before environment substitution. Unresolved
  // chain references block the send — a raw `{{login.…}}` on the wire is
  // never what the user meant (issue #47).
  const chainName = req.directives['name'];
  const chained = prepareChainSend(
    { url: req.url, headers: req.headers, body: req.body },
    chainStore,
  );
  if (chained.diagnostics.length > 0) {
    const refs = [...new Set(chained.diagnostics.map((d) => d.variable))].join(', ');
    const details = chained.diagnostics.map((d) => `${d.variable}: ${d.message}`).join('; ');
    vscode.window.showErrorMessage(
      `Reqit: unresolved chain references (${envManager.active}): ${refs} — ${details}`,
    );
    return;
  }
  // A declared-but-invalid `@name` can never be referenced; surface it now
  // rather than recording an unusable entry (recording skips it too).
  if (chainName !== undefined && !isValidChainName(chainName)) {
    vscode.window.showWarningMessage(
      `Reqit: ${validateRequestNames([chainName])[0]} — this response will not be referenceable.`,
    );
  }

  const { resolve, secretValues } = await envManager.buildResolver();
  const substituted = substituteRequest(
    { url: chained.url, headers: chained.headers, body: chained.body },
    { resolve },
  );
  if (substituted.diagnostics.length > 0) {
    const names = [...new Set(substituted.diagnostics.map((d) => d.variable))].join(', ');
    vscode.window.showErrorMessage(
      `Reqit: unresolved variables (${envManager.active}): ${names}`,
    );
    return;
  }
  const requestForUndici: ParsedRequest = {
    ...req,
    url: substituted.url,
    headers: substituted.headers,
    body: substituted.body,
  };
  // Compute the redaction set BEFORE the first fallible step whose error
  // text can echo substituted request data (issue #47 review C). Sources:
  // (a) chain-resolved secret captures, (b) the active environment's
  // SecretStorage values — a capture may hold a template like `{{inner}}`
  // that the env stage later expands into the real secret, so the capture
  // value alone never appears in the final wire string. Scrubbing is
  // longest-first with the JSON-escaped form inside `redactSecretText`.
  //
  // Taint closure (issue #47 review F1-R3): the expansion is not limited to
  // SecretStorage — if a secret's text contains ANY reference the env stage
  // injected (ordinary env var or builtin like `$guid`, which cannot be
  // recomputed), the injected value is what reached the wire for that
  // secret and must join the redaction set. Bounded passes; the source list
  // only ever grows by values derived from values already known secret.
  const renderSecrets = [...chained.resolvedSecrets, ...secretValues];
  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    for (const inj of substituted.injected) {
      if (
        inj.value !== '' &&
        !renderSecrets.includes(inj.value) &&
        renderSecrets.some((sec) => sec.includes(inj.reference))
      ) {
        renderSecrets.push(inj.value);
        grew = true;
      }
    }
    if (!grew) break;
  }
  // One helper for every user-facing text derived from this request's
  // substitution stage: transport/validator error messages and stacks all
  // route through here (issue #47 review C — a raw exception can embed the
  // secret-bearing URL or bare secret text).
  const redactUserText = (text: string): string =>
    redactSecretText(sanitizeSseErrorText(text, 4000), renderSecrets);
  let opts;
  try {
    opts = toUndiciRequest(requestForUndici);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Reqit: invalid request — ${redactUserText((err as Error).message ?? String(err))}`,
    );
    return;
  }
  // Rendered echo of the request with secret capture values redacted: the
  // wire request carries them, derived surfaces must not (see
  // `redactSecretText`). EVERY string field in the render copy is scrubbed
  // — url, header values, AND body — because the rendered request object
  // crosses into the webview (issue #47 review B2: url+headers-only redaction
  // leaked secret-substituted bodies).
  const renderRequest = {
    ...opts,
    url: redactSecretText(opts.url, renderSecrets),
    headers: Object.fromEntries(
      Object.entries(opts.headers).map(([k, v]) => [
        k,
        redactSecretText(String(v), renderSecrets),
      ]),
    ),
    ...(opts.body !== undefined
      ? { body: redactSecretText(opts.body, renderSecrets) }
      : {}),
  };

  // Dynamic import — keeps activation cheap and avoids bundling undici into the activation path.
  const { request } = await import('undici');
  const started = Date.now();
  // Register the session BEFORE the first byte arrives so `Stop stream`
  // can also cancel a request hanging on response headers (the SSE stop
  // acceptance path must reach every live lifecycle state).
  const stream = sseStreams.start();
  try {
    const res = await request(opts.url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      signal: stream.signal,
    });
    const responseHeaders: Record<string, string> = Object.fromEntries(
      Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]),
    );
    // Recorded request bodies are scrubbed with the SAME redaction set the
    // render echo uses (issue #47 review F1-R3): the store outlives the
    // current environment (rotating/switching envs drops values from the
    // redaction list), so `{{name.request.body.$…}}` must never be able to
    // re-surface a secret that was only current at record time. The wire
    // request keeps the real body; only the STORE copy is scrubbed.
    const recordedBody = redactSecretText(opts.body ?? '', renderSecrets);
    if (isSseResponse(res.headers)) {
      // SSE streams have no single response body to capture from; record
      // the exchange with an empty body so at least `{{name.response.status}}`
      // and header references resolve downstream. Event-level capture is
      // outside this slice.
      const sseRecord = recordChainExchange(
        chainStore,
        chainName,
        req.captures,
        recordedBody,
        { received: true, status: res.statusCode, headers: responseHeaders, body: '' },
      );
      reportCaptureDiagnostics(sseRecord.diagnostics);
      // The TRANSPORT keeps the real wire `opts` (reconnects replay it —
      // secrets must survive there); only the VIEW copy is redacted
      // (issue #47 review B1).
      await streamSseResponse(
        context,
        req,
        opts,
        renderRequest,
        res,
        responseHeaders,
        started,
        stream,
        renderSecrets,
      );
      return;
    }
    const bodyText = await res.body.text();
    const elapsedMs = Date.now() - started;
    const exchangeRecord = recordChainExchange(
      chainStore,
      chainName,
      req.captures,
      recordedBody,
      { received: true, status: res.statusCode, headers: responseHeaders, body: bodyText },
    );
    reportCaptureDiagnostics(exchangeRecord.diagnostics);
    renderResponse(context, {
      request: renderRequest,
      status: res.statusCode,
      headers: responseHeaders,
      body: bodyText,
      elapsedMs,
    });
  } catch (err) {
    const elapsedMs = Date.now() - started;
    // Transport failure / user cancellation: record NOTHING. Downstream
    // chain references keep failing loudly against the last genuinely
    // received state (issue #47 error semantics).
    if (stream.signal.aborted) {
      // The user stopped this request while it was waiting for response
      // headers: `Stop stream` already reported it; don't double-report
      // a deliberate cancellation as a transport failure.
      return;
    }
    const message = redactUserText((err as Error).message ?? String(err));
    vscode.window.showErrorMessage(`Reqit: request failed — ${message}`);
    renderResponse(context, {
      request: renderRequest,
      status: 0,
      headers: {},
      body: `// Error after ${elapsedMs}ms\n${redactUserText((err as Error).stack ?? (err as Error).message ?? String(err))}`,
      elapsedMs,
    });
  } finally {
    // Deregister unconditionally: `release()` is idempotent and never
    // aborts, so this covers non-SSE responses, request failures, AND a
    // throw inside streamSseResponse's setup before its own finally is
    // reached. By the time this runs the SSE driver has settled (or its
    // setup threw), so no live session is deregistered early.
    stream.release();
  }
}

/**
 * Drive an SSE response into the streaming response webview.
 *
 * Detection lives in the caller (`isSseResponse`). This helper owns:
 *   - decoding the undici body stream into UTF-8 text chunks,
 *   - handing them to the pure {@link runSseTransport} driver,
 *   - refreshing the webview after each event (throttled to a paint),
 *   - surfacing @sse-until compile errors as a warning note without
 *     killing the stream.
 *
 * Reconnect / `Last-Event-ID` is wired through the pure core transport
 * helper (`runSseTransportWithReconnect`) with a bounded reconnect budget.
 * The extension adapter only opens sockets and paints the webview.
 */
async function streamSseResponse(
  context: vscode.ExtensionContext,
  req: ParsedRequest,
  opts: import('../core/request.js').UndiciRequestOptions,
  viewOpts: import('../core/request.js').UndiciRequestOptions,
  res: { statusCode: number; body: AsyncIterable<unknown> },
  responseHeaders: Record<string, string>,
  _started: number,
  stream: SseStreamHandle,
  renderSecrets: readonly string[],
): Promise<void> {
  // `opts` is the REAL wire request and stays exclusive to the transport
  // (reconnects replay it verbatim); `viewOpts` is the redacted copy that
  // may cross into the rendered panel (issue #47 review B1).
  const requestForView = viewOpts;
  const directives = sseOptionsFromDirectives(req.directives);
  const events: SseRenderEvent[] = [];
  const transcriptRecords: SseTranscriptRecord[] = [];
  lastSseTranscript = undefined;
  const initialNote = directives.diagnostics.length > 0
    ? `SSE directives ignored: ${directives.diagnostics.map((d) => `${d.directive} (${d.message})`).join('; ')}`
    : undefined;
  const state: SseRenderState = {
    request: requestForView,
    status: res.statusCode,
    headers: responseHeaders,
    elapsedMs: 0,
    events,
    streaming: true,
    ...(initialNote !== undefined ? { note: initialNote } : {}),
    // The webview "Stop stream" button routes here via the validated
    // message channel. `stream.abort()` is idempotent and id-scoped: it
    // only ever stops THIS session (never whatever happens to be last).
    onStop: () => {
      stream.abort();
    },
  };
  const handle = renderSseResponse(context, state);
  // The registry handle is created by the caller (before the first byte)
  // and owned here until the driver settles; `stream.release()` below is
  // the single deregistration point for the SSE path.

  /**
   * Destroy the live HTTP body when the user stops the stream (or the
   * extension deactivates), so the socket is released immediately instead
   * of lingering until the server closes it. Rejections from a destroyed
   * body are absorbed by the transport's abort race in `runSseTransport`.
   */
  const destroyBodyOnStop = (body: { destroy?: () => void } | AsyncIterable<unknown>): void => {
    const destroyable = body as { destroy?: () => void };
    if (typeof destroyable.destroy === 'function') {
      try {
        destroyable.destroy();
      } catch {
        // Body already gone — nothing to release.
      }
    }
  };
  closeOnAbort(stream.signal, () => {
    destroyBodyOnStop(res.body);
  });

  const decodeBody = (
    body: AsyncIterable<Uint8Array | string>,
  ): AsyncIterable<string> => (async function* (): AsyncGenerator<string> {
    const decoder = new TextDecoder('utf-8');
    for await (const chunk of body) {
      if (typeof chunk === 'string') {
        yield chunk;
      } else {
        yield decoder.decode(chunk, { stream: true });
      }
    }
    const tail = decoder.decode();
    if (tail.length > 0) yield tail;
  })();

  let usedInitialResponse = false;
  const { request } = await import('undici');

  const options: Parameters<typeof runSseTransportWithReconnect>[0] = {
    connect: async ({ headers }) => {
      if (!usedInitialResponse) {
        usedInitialResponse = true;
        return decodeBody(res.body as AsyncIterable<Uint8Array | string>);
      }
      const reconnectResponse = await request(opts.url, {
        method: opts.method,
        headers: {
          ...opts.headers,
          ...headers,
        },
        body: opts.body,
        // Bind the reconnect request to the stream's stop signal so a
        // "Stop stream" during connect() cancels the in-flight socket
        // instead of resolving later with an orphaned body.
        signal: stream.signal,
      });
      if (!isSseResponse(reconnectResponse.headers as Record<string, string | string[] | undefined>)) {
        const contentType = reconnectResponse.headers['content-type'];
        const contentTypeText = Array.isArray(contentType)
          ? contentType.join(', ')
          : String(contentType ?? 'unknown');
        throw new Error(`SSE reconnect response is not event-stream (content-type=${contentTypeText})`);
      }
      state.status = reconnectResponse.statusCode;
      state.headers = Object.fromEntries(
        Object.entries(reconnectResponse.headers).map(([k, v]) => [
          k,
          Array.isArray(v) ? v.join(', ') : String(v ?? ''),
        ]),
      );
      closeOnAbort(stream.signal, () => {
        destroyBodyOnStop(reconnectResponse.body);
      });
      return decodeBody(reconnectResponse.body.setEncoding('utf8'));
    },
    signal: stream.signal,
    onEvent: (event, meta) => {
      const eventTimestampMs = Date.now();
      events.push({ event, meta, timestamp: new Date(eventTimestampMs).toISOString() });
      // Capture through the production allowlist boundary: even though
      // `opts` (auth headers included) is in scope here, only the three
      // record fields can enter the transcript.
      transcriptRecords.push(
        pickSseTranscriptRecord({ event, index: meta.index, timestampMs: eventTimestampMs, sentRequest: opts }),
      );
      state.elapsedMs = meta.elapsedMs;
      handle.update({ ...state, events: [...events] });
    },
    ...(directives.options.until !== undefined ? { until: directives.options.until } : {}),
    ...(directives.options.maxEvents !== undefined ? { maxEvents: directives.options.maxEvents } : {}),
    ...(directives.options.maxDurationMs !== undefined
      ? { maxDurationMs: directives.options.maxDurationMs }
      : {}),
    ...(directives.options.idleMs !== undefined ? { idleMs: directives.options.idleMs } : {}),
  };

  try {
    const result = await runSseTransportWithReconnect(options);
    const parts: string[] = [];
    if (initialNote) parts.push(initialNote);
    if (result.untilError) parts.push(`@sse-until error: ${result.untilError}`);
    if (result.reconnectCount > 0) {
      parts.push(`reconnected ${result.reconnectCount}x`);
    }
    if (result.reason === 'reconnect-limit') {
      parts.push('reconnect limit reached');
    }
    const finalNote = parts.length > 0 ? parts.join(' | ') : undefined;
    handle.update({
      ...state,
      streaming: false,
      stopReason: result.reason,
      elapsedMs: result.durationMs,
      events: [...events],
      ...(finalNote !== undefined ? { note: finalNote } : {}),
    });
    // Dispose the message channel IMMEDIATELY after the terminal render —
    // BEFORE awaiting the transcript prompt, which can stay unresolved
    // indefinitely. A completed session must never keep a live stop
    // listener (or panel ownership) while the user decides on the save.
    // Idempotent; the finally below stays as the failure-path net.
    handle.dispose();

    lastSseTranscript = buildLastSseTranscript(transcriptRecords);
    // The driver has finished: deregister BEFORE awaiting any follow-up
    // prompt, so `Stop stream` can never report or touch this dead
    // session while the user decides on the transcript save. (release()
    // is idempotent; the finally below stays as a failure-path net.)
    stream.release();
    if (lastSseTranscript !== undefined) {
      const transcript = lastSseTranscript;
      const action = await vscode.window.showInformationMessage(
        `Reqit: SSE stream captured ${transcript.eventCount} events.`,
        'Save transcript',
      );
      if (action === 'Save transcript') {
        try {
          await saveSseTranscript(transcript);
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          vscode.window.showWarningMessage(
            `Reqit: stream completed but transcript save failed — ${message}`,
          );
        }
      }
    }
  } catch (err) {
    // Same redaction discipline as the plain path (issue #47 review C): a
    // transport error can embed the secret-bearing URL or bare secret text.
    const message = redactSecretText(
      sanitizeSseErrorText((err as Error).message ?? String(err)),
      renderSecrets,
    );
    lastSseTranscript = buildLastSseTranscript(transcriptRecords);
    handle.update({
      ...state,
      streaming: false,
      stopReason: 'end-of-stream',
      events: [...events],
      note: `SSE transport failed: ${message}`,
    });
    vscode.window.showErrorMessage(`Reqit: SSE stream failed \u2014 ${message}`);
  } finally {
    // Driver finished (naturally, stopped, or failed): deregister so a
    // later `Stop stream` never targets a dead session. Idempotent and
    // never aborts, so the transcript above is unaffected.
    stream.release();
    // Release the webview message channel and panel ownership too, on
    // EVERY terminal path (success, stop, transport failure): a completed
    // session must never keep a live stop listener behind the rendered
    // (now dead) button.
    handle.dispose();
  }
}
