import * as vscode from 'vscode';
import { parseHttpFile, type ParsedRequest } from '../core/parser.js';

/**
 * Tree view backing "Reqit Requests".
 *
 * Scope: `.requests/` (recursive) under the first workspace folder.
 * Grouping: subfolders are folder nodes, `.http` files are file nodes, each
 * file expands into its parsed requests (using `### name` when present).
 */
export class RequestsTreeProvider implements vscode.TreeDataProvider<RequestsNode> {
  private readonly _onDidChange = new vscode.EventEmitter<RequestsNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(node: RequestsNode): vscode.TreeItem {
    return node.toTreeItem();
  }

  async getChildren(node?: RequestsNode): Promise<RequestsNode[]> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return [];
    const root = vscode.Uri.joinPath(folder.uri, '.requests');

    if (!node) {
      if (!(await dirExists(root))) {
        return [new MessageNode('Run "Reqit: Init Workspace" to create .requests/')];
      }
      return listDir(root);
    }
    if (node.kind === 'folder') {
      return listDir(node.uri);
    }
    if (node.kind === 'file') {
      return parseFileRequests(node.uri);
    }
    return [];
  }
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
    const child = vscode.Uri.joinPath(uri, name);
    if (type & vscode.FileType.Directory) {
      out.push(new FolderNode(name, child));
    } else if ((type & vscode.FileType.File) !== 0 && name.toLowerCase().endsWith('.http')) {
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

async function parseFileRequests(uri: vscode.Uri): Promise<RequestsNode[]> {
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    return [];
  }
  const text = new TextDecoder().decode(bytes);
  const { requests } = parseHttpFile(text);
  return requests.map((r, i) => new RequestNode(uri, r, i));
}

export type RequestsNode = FolderNode | FileNode | RequestNode | MessageNode;

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
    this.label = request.name ?? `${request.method} ${shortUrl(request.url)}`;
  }
  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.None);
    item.description = `${this.request.method}`;
    item.tooltip = `${this.request.method} ${this.request.url}`;
    item.iconPath = new vscode.ThemeIcon('symbol-event');
    item.contextValue = 'reqit.request';
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

function shortUrl(url: string): string {
  if (url.length <= 60) return url;
  return url.slice(0, 57) + '...';
}
