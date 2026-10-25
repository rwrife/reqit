import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { HTTP_METHODS, parseHttpFile, type ParsedRequest } from '../core/parser.js';
import { parseGrpcFile, type ParsedGrpcRequestWithRange } from '../core/grpc.js';
import { parseTagList } from '../core/tags.js';

/**
 * Tree view backing "Reqit Requests".
 *
 * Scope: `.requests/` (recursive) under each approved VS Code workspace folder.
 * Grouping: subfolders are folder nodes, `.http` files are file nodes, each
 * file expands into its parsed requests (using `### name` when present).
 */
export const REQUEST_NAME_SEARCH_MAX_LENGTH = 128;
export const RECENT_REQUESTS_MAX_CAPACITY = 50;

export interface RecentRequestAnchor {
  readonly uriString: string;
  readonly requestLineIndex: number;
  readonly name?: string;
  readonly method?: string;
  readonly url?: string;
}

/**
 * Upper bound on the source length eligible for section text search
 * (issue #56). Searching joins a per-line scan across the whole file on
 * every expand, so oversized files get an explicit refusal instead of an
 * unbounded synchronous scan or a misleading "no matches" message.
 */
export const REQUEST_TEXT_SEARCH_MAX_SOURCE_LENGTH = 1_048_576;

export class RequestsTreeProvider implements vscode.TreeDataProvider<RequestsNode> {
  private readonly _onDidChange = new vscode.EventEmitter<RequestsNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  // Presentation-only filters: never persisted, and never resolve secrets.
  private methodFilter: string | undefined;
  private nameSearchFilter: string | undefined;
  private urlSearchFilter: string | undefined;
  private tagSearchFilter: string | undefined;
  private textSearchFilter: string | undefined;
  private favoritesOnly = false;
  private recentOnly = false;
  // ponytail: keep at most 50 session anchors; no response/history persistence.
  private readonly recent = new Map<string, string>();

  private recentFingerprint(anchor: RecentRequestAnchor): string {
    return createHash('sha256').update(JSON.stringify([
      anchor.uriString, anchor.requestLineIndex, anchor.method, anchor.url, anchor.name,
    ])).digest('hex');
  }

  private recentKey(uri: vscode.Uri, line: number): string {
    return createHash('sha256').update(JSON.stringify([uri.toString(), line])).digest('hex');
  }

  isRecentOnly(): boolean {
    return this.recentOnly;
  }

  setRecentOnly(enabled: boolean): boolean {
    if (this.recentOnly === enabled) return false;
    this.recentOnly = enabled;
    this.refresh();
    return true;
  }

  markRecent(node: unknown): boolean {
    if (!(node instanceof RequestNode) || !this.isRequestNode(node)) return false;
    return this.recordRecent({
      uriString: node.uri.toString(),
      requestLineIndex: node.request.requestLineIndex,
      name: node.request.name,
      method: node.request.method,
      url: node.request.url,
    });
  }

  recordRecent(anchor: RecentRequestAnchor): boolean {
    if (
      !Number.isSafeInteger(anchor.requestLineIndex) || anchor.requestLineIndex < 0 ||
      typeof anchor.uriString !== 'string' || anchor.uriString.length > 4096 ||
      !Number.isSafeInteger(anchor.uriString.length)
    ) return false;
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(anchor.uriString);
    } catch {
      return false;
    }
    if (!/\.http$/i.test(uri.path) || !(vscode.workspace.workspaceFolders ?? []).some((folder) =>
      uri.scheme === folder.uri.scheme &&
      uri.authority === folder.uri.authority &&
      uri.path.startsWith(`${folder.uri.path.replace(/\/$/, '')}/.requests/`))) return false;
    const key = this.recentKey(uri, anchor.requestLineIndex);
    const fingerprint = this.recentFingerprint(anchor);
    this.recent.delete(key);
    this.recent.set(key, fingerprint);
    if (this.recent.size > RECENT_REQUESTS_MAX_CAPACITY) this.recent.delete(this.recent.keys().next().value!);
    // Only repaint while the recent view is on; recording while hidden must
    // not churn the tree (a send-triggered refresh could re-enter rendering).
    if (this.recentOnly) this.refresh();
    return true;
  }

  isRecent(node: RequestsNode): boolean {
    if (node.kind !== 'request') return false;
    const key = this.recentKey(node.uri, node.request.requestLineIndex);
    const expected = this.recent.get(key);
    if (!expected) return false;
    const actual = this.recentFingerprint({
      uriString: node.uri.toString(),
      requestLineIndex: node.request.requestLineIndex,
      name: node.request.name,
      method: node.request.method,
      url: node.request.url,
    });
    return actual === expected;
  }

  isFavoritesOnly(): boolean {
    return this.favoritesOnly;
  }

  setFavoritesOnly(enabled: boolean): boolean {
    if (this.favoritesOnly === enabled) return false;
    this.favoritesOnly = enabled;
    this.refresh();
    return true;
  }

  hasTextSearchFilter(): boolean {
    return this.textSearchFilter !== undefined;
  }

  setTextFilter(query: unknown): boolean {
    if (query !== undefined && typeof query !== 'string') return false;
    if (typeof query === 'string' && query.length > REQUEST_NAME_SEARCH_MAX_LENGTH) return false;
    const normalized = query === undefined || query.length === 0 ? undefined : query.toLowerCase();
    if (this.textSearchFilter === normalized) return false;
    this.textSearchFilter = normalized;
    this.refresh();
    return true;
  }

  hasTagSearchFilter(): boolean {
    return this.tagSearchFilter !== undefined;
  }

  /**
   * Exact (case-insensitive) single-tag filter over `# @tag` directive
   * tokens. A comma separates tags inside the directive, so a comma can
   * never occur in one token: filter text containing one is invalid input,
   * not a query that silently matches nothing.
   */
  setTagFilter(query: unknown): boolean {
    if (query !== undefined && typeof query !== 'string') return false;
    let normalized: string | undefined;
    if (typeof query === 'string') {
      const trimmed = query.trim().toLowerCase();
      if (trimmed.length > REQUEST_NAME_SEARCH_MAX_LENGTH) return false;
      if (trimmed.includes(',')) return false;
      if (trimmed.length > 0) normalized = trimmed;
    }
    if (this.tagSearchFilter === normalized) return false;
    this.tagSearchFilter = normalized;
    this.refresh();
    return true;
  }

  hasUrlSearchFilter(): boolean {
    return this.urlSearchFilter !== undefined;
  }

  setUrlFilter(query: unknown): boolean {
    if (query !== undefined && typeof query !== 'string') return false;
    if (typeof query === 'string' && query.length > REQUEST_NAME_SEARCH_MAX_LENGTH) return false;
    const normalized = query === undefined || query.length === 0 ? undefined : query.toLowerCase();
    if (this.urlSearchFilter === normalized) return false;
    this.urlSearchFilter = normalized;
    this.refresh();
    return true;
  }

  setMethodFilter(method: unknown): boolean {
    if (
      method !== undefined &&
      (typeof method !== 'string' ||
        !(method === 'GRPC' || HTTP_METHODS.some((allowed) => allowed === method)))
    )
      return false;
    if (this.methodFilter === method) return false;
    this.methodFilter = method;
    this.refresh();
    return true;
  }

  getMethodFilter(): string | undefined {
    return this.methodFilter;
  }

  hasNameSearchFilter(): boolean {
    return this.nameSearchFilter !== undefined;
  }

  setNameFilter(query: unknown): boolean {
    if (query !== undefined && typeof query !== 'string') return false;
    if (typeof query === 'string' && query.length > REQUEST_NAME_SEARCH_MAX_LENGTH) return false;

    const normalized =
      query === undefined || query.length === 0 ? undefined : query.toLocaleLowerCase();
    if (this.nameSearchFilter === normalized) return false;
    this.nameSearchFilter = normalized;
    this.refresh();
    return true;
  }

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  isRequestNode(node: unknown): node is Extract<RequestsNode, { kind: 'request' }> {
    if (!(node instanceof RequestNode)) return false;
    return (vscode.workspace.workspaceFolders ?? []).some(
      (folder) =>
        node.uri.scheme === folder.uri.scheme &&
        node.uri.authority === folder.uri.authority &&
        node.uri.path.startsWith(`${folder.uri.path.replace(/\/$/, '')}/.requests/`),
    );
  }

  getTreeItem(node: RequestsNode): vscode.TreeItem {
    return node.toTreeItem();
  }

  async getChildren(node?: RequestsNode): Promise<RequestsNode[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!node) {
      if (folders.length === 0) {
        return [new MessageNode('Open a workspace folder, then run "Reqit: Init Workspace"')];
      }
      if (folders.length > 1) {
        return folders.map((folder) => new WorkspaceNode(folder.name, folder.uri));
      }
      const root = vscode.Uri.joinPath(folders[0].uri, '.requests');
      return (await dirExists(root))
        ? listDir(root)
        : [new MessageNode('Run "Reqit: Init Workspace" to create .requests/')];
    }
    if (node.kind === 'workspace') {
      if (!folders.some((folder) => folder.uri.toString() === node.uri.toString())) return [];
      const root = vscode.Uri.joinPath(node.uri, '.requests');
      return (await dirExists(root))
        ? listDir(root)
        : [new MessageNode('Run "Reqit: Init Workspace" to create .requests/')];
    }
    if (node.kind === 'message') return [];
    // ponytail: URI containment rejects stale tree nodes, not symlink swaps at final I/O.
    if (!folders.some((folder) =>
      node.uri.scheme === folder.uri.scheme &&
      node.uri.authority === folder.uri.authority &&
      node.uri.path.startsWith(`${folder.uri.path.replace(/\/$/, '')}/.requests/`))) return [];
    if (node.kind === 'folder') {
      return listDir(node.uri);
    }
    if (node.kind === 'file') {
      const { nodes: requests, lines, tooLargeForTextSearch } = await parseFileRequests(
        node.uri,
        () => this.textSearchFilter !== undefined,
      );
      // Read current filters AFTER I/O so a late read cannot restore obsolete
      // selections. Do not renumber nodes: their send anchors survive.
      const methodFilter = this.methodFilter;
      const nameSearchFilter = this.nameSearchFilter;
      const urlSearchFilter = this.urlSearchFilter;
      const tagSearchFilter = this.tagSearchFilter;
      const textSearchFilter = this.textSearchFilter;
      const favoritesOnly = this.favoritesOnly;
      const recentOnly = this.recentOnly;
      if (tooLargeForTextSearch) {
        return [new MessageNode('File too large for text search')];
      }
      const filtered = requests.filter(
        (request) =>
          matchesMethodFilter(request, methodFilter) &&
          matchesNameFilter(request, nameSearchFilter) &&
          (urlSearchFilter === undefined ||
            (request.kind === 'request' &&
              request.request.url.toLowerCase().includes(urlSearchFilter))) &&
          matchesTagFilter(request, tagSearchFilter) &&
          matchesTextFilter(lines, request, textSearchFilter) &&
          (!favoritesOnly ||
            (request.kind === 'request' && request.request.directives['favorite'] === 'true')) &&
          (!recentOnly || this.isRecent(request)),
      );
      return requests.length > 0 && filtered.length === 0
        ? [
            new MessageNode(
              noMatchMessage(
                methodFilter,
                nameSearchFilter,
                urlSearchFilter,
                tagSearchFilter,
                textSearchFilter,
                favoritesOnly,
                recentOnly,
              ),
            ),
          ]
        : filtered;
    }
    return [];
  }
}

function matchesMethodFilter(request: RequestsNode, methodFilter: string | undefined): boolean {
  return (
    methodFilter === undefined ||
    (request.kind === 'request' && request.request.method === methodFilter) ||
    (request.kind === 'grpc-request' && methodFilter === 'GRPC')
  );
}

function matchesNameFilter(request: RequestsNode, nameSearchFilter: string | undefined): boolean {
  if (nameSearchFilter === undefined) return true;
  if (request.kind === 'request') {
    return request.request.name?.toLocaleLowerCase().includes(nameSearchFilter) ?? false;
  }
  if (request.kind === 'grpc-request') {
    return request.request.name?.toLocaleLowerCase().includes(nameSearchFilter) ?? false;
  }
  return false;
}

function matchesTagFilter(request: RequestsNode, tagSearchFilter: string | undefined): boolean {
  if (tagSearchFilter === undefined) return true;
  // gRPC requests have no directive surface yet; tags are HTTP-only, like
  // URL search, rather than a second label guess.
  return (
    request.kind === 'request' && parseTagList(request.request.directives['tag']).includes(
      tagSearchFilter,
    )
  );
}

function matchesTextFilter(
  lines: string[],
  request: RequestsNode,
  textSearchFilter: string | undefined,
): boolean {
  if (textSearchFilter === undefined) return true;
  // Section-scoped literal search: both request kinds carry [startLine,
  // endLine) from their parser, so matching stays on source the user can
  // see in the file and never invents a cross-request match.
  if (request.kind !== 'request' && request.kind !== 'grpc-request') return false;
  for (let i = request.request.startLine; i < request.request.endLine && i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(textSearchFilter)) return true;
  }
  return false;
}

function noMatchMessage(
  methodFilter: string | undefined,
  nameSearchFilter: string | undefined,
  urlSearchFilter: string | undefined,
  tagSearchFilter: string | undefined,
  textSearchFilter: string | undefined,
  favoritesOnly: boolean,
  recentOnly: boolean,
): string {
  const active =
    [methodFilter, nameSearchFilter, urlSearchFilter, tagSearchFilter, textSearchFilter].filter(
      (v) => v !== undefined,
    ).length + (favoritesOnly ? 1 : 0) + (recentOnly ? 1 : 0);
  if (active > 1) {
    return 'No requests match current filters';
  }
  if (nameSearchFilter !== undefined) {
    return 'No requests match the active name search';
  }
  if (urlSearchFilter !== undefined) {
    return 'No requests match the active URL search';
  }
  if (tagSearchFilter !== undefined) {
    return 'No requests match the active tag search';
  }
  if (textSearchFilter !== undefined) {
    return 'No requests match the active text search';
  }
  if (favoritesOnly) return 'No requests match the favorites filter';
  if (recentOnly) return 'No requests match the recent filter';
  return 'No requests match the method filter';
}

async function dirExists(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return (stat.type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

async function listDir(uri: vscode.Uri): Promise<RequestsNode[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(uri);
  } catch {
    return [];
  }
  const out: RequestsNode[] = [];
  for (const [name, type] of entries) {
    // ponytail: skip links reported by discovery; race-safe confinement needs no-follow I/O.
    if (type & vscode.FileType.SymbolicLink) continue;
    const child = vscode.Uri.joinPath(uri, name);
    if (type & vscode.FileType.Directory) {
      out.push(new FolderNode(name, child));
    } else if ((type & vscode.FileType.File) !== 0 && /\.(http|grpc)$/i.test(name)) {
      out.push(new FileNode(name, child));
    }
  }
  // Folders first, then files, both alpha.
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return out;
}

async function parseFileRequests(
  uri: vscode.Uri,
  textSearchActive: () => boolean,
): Promise<{ nodes: RequestsNode[]; lines: string[]; tooLargeForTextSearch: boolean }> {
  const empty = { nodes: [], lines: [], tooLargeForTextSearch: false };
  // Evaluated after the read: a filter set during a pending read still gates.
  const oversized = (text: string) =>
    text.length > REQUEST_TEXT_SEARCH_MAX_SOURCE_LENGTH && textSearchActive();
  const openText = (): string | undefined =>
    vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString())?.getText();
  let text = openText();
  if (text === undefined) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      // An editor may open or change while the disk read is pending.
      text = openText() ?? new TextDecoder().decode(bytes);
    } catch {
      text = openText();
      if (text === undefined) return empty;
    }
  }
  // Refuse oversize scans BEFORE splitting or parsing: the refusal promise is
  // that no unbounded work happens for a file text search cannot cover.
  if (oversized(text)) return { nodes: [], lines: [], tooLargeForTextSearch: true };
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (/\.grpc$/i.test(uri.path)) {
    const { requests } = parseGrpcFile(text);
    return { nodes: requests.map((r, i) => new GrpcRequestNode(uri, r, i)), lines, tooLargeForTextSearch: false };
  }
  const { requests } = parseHttpFile(text);
  return { nodes: requests.map((r, i) => new RequestNode(uri, r, i)), lines, tooLargeForTextSearch: false };
}

export type RequestsNode = WorkspaceNode | FolderNode | FileNode | RequestNode | GrpcRequestNode | MessageNode;

class WorkspaceNode {
  readonly kind = 'workspace' as const;
  constructor(readonly label: string, readonly uri: vscode.Uri) {}
  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.Collapsed);
    item.iconPath = vscode.ThemeIcon.Folder;
    return item;
  }
}

class FolderNode {
  readonly kind = 'folder' as const;
  constructor(
    readonly label: string,
    readonly uri: vscode.Uri,
  ) {}
  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.Collapsed);
    item.resourceUri = this.uri;
    item.iconPath = vscode.ThemeIcon.Folder;
    item.contextValue = 'reqit.folder';
    return item;
  }
}

class FileNode {
  readonly kind = 'file' as const;
  constructor(
    readonly label: string,
    readonly uri: vscode.Uri,
  ) {}
  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.Collapsed);
    item.resourceUri = this.uri;
    item.iconPath = vscode.ThemeIcon.File;
    item.contextValue = 'reqit.file';
    item.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [this.uri],
    };
    return item;
  }
}

class RequestNode {
  readonly kind = 'request' as const;
  readonly label: string;
  constructor(
    readonly uri: vscode.Uri,
    readonly request: ParsedRequest,
    readonly index: number,
  ) {
    // ponytail: unnamed requests show the method only; a URL can carry arbitrary secrets.
    this.label = request.name ?? `${request.method} request`;
  }
  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.None);
    item.description = `${this.request.method}`;
    item.tooltip = `${this.request.method} request`;
    const favorite = this.request.directives['favorite'] === 'true';
    // ponytail: star marks the portable `# @favorite true` directive state.
    item.iconPath = new vscode.ThemeIcon(favorite ? 'star-full' : 'symbol-event');
    // ponytail: distinct contextValue lets the inline toggle button match favorited rows too.
    item.contextValue = favorite ? 'reqit.request.favorite' : 'reqit.request';
    item.command = {
      command: 'reqit.sendRequest',
      title: '▶ Send Request',
      arguments: [
        {
          documentUri: this.uri.toString(),
          requestLineIndex: this.request.requestLineIndex,
        },
      ],
    };
    return item;
  }
}

class MessageNode {
  readonly kind = 'message' as const;
  readonly label: string;
  constructor(label: string) {
    this.label = label;
  }
  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'reqit.message';
    return item;
  }
}

class GrpcRequestNode {
  readonly kind = 'grpc-request' as const;
  readonly label: string;
  constructor(
    readonly uri: vscode.Uri,
    readonly request: ParsedGrpcRequestWithRange,
    readonly index: number,
  ) {
    const t = request.target;
    this.label = request.name ?? `${t.host}/${t.service}/${t.method}`;
  }
  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.None);
    item.description = 'GRPC';
    const t = this.request.target;
    item.tooltip = `GRPC ${t.host}:${t.port}/${t.service}/${t.method}`;
    item.iconPath = new vscode.ThemeIcon('symbol-event');
    item.contextValue = 'reqit.grpcRequest';
    item.command = {
      command: 'reqit.sendGrpcRequest',
      title: '▶ Send Request',
      arguments: [
        {
          documentUri: this.uri.toString(),
          requestLineIndex: this.request.requestLineIndex,
        },
      ],
    };
    return item;
  }
}
