import * as vscode from 'vscode';
import {
  isSecretMarker,
  listSecretVars,
  parseEnvFile,
  type Env,
  type EnvFile,
} from '../core/env.js';

const ACTIVE_ENV_KEY = 'reqit.activeEnv';
const SECRET_PREFIX = 'reqit.secret.';

/**
 * Loads `.requests/.http-env.json`, tracks the active environment, exposes a
 * status-bar picker, and resolves variables (including SecretStorage secrets)
 * on demand. Pure substitution/parsing live in `src/core/`; this is the glue.
 */
export class EnvManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusItem: vscode.StatusBarItem;
  private envs: EnvFile = {};
  private loadError: string | undefined;
  private activeEnv = 'default';
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.activeEnv = context.workspaceState.get<string>(ACTIVE_ENV_KEY) ?? 'default';
    this.statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusItem.command = 'reqit.selectEnv';
    this.statusItem.tooltip = 'Reqit: switch environment';
    this.disposables.push(this.statusItem, this.emitter);

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, '.requests/.http-env.json'),
      );
      watcher.onDidCreate(() => void this.reload());
      watcher.onDidChange(() => void this.reload());
      watcher.onDidDelete(() => void this.reload());
      this.disposables.push(watcher);
    }
  }

  get active(): string {
    return this.activeEnv;
  }

  get availableEnvs(): string[] {
    return Object.keys(this.envs);
  }

  get loadErrorMessage(): string | undefined {
    return this.loadError;
  }

  async init(): Promise<void> {
    await this.reload();
    this.statusItem.show();
  }

  async reload(): Promise<void> {
    const uri = this.envFileUri();
    if (!uri) {
      this.envs = {};
      this.loadError = undefined;
      this.render();
      this.emitter.fire();
      return;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const parsed = parseEnvFile(Buffer.from(bytes).toString('utf8'));
      if (!parsed.ok) {
        this.envs = {};
        this.loadError = parsed.error;
      } else {
        this.envs = parsed.envs;
        this.loadError = undefined;
        if (!this.envs[this.activeEnv]) {
          // Prefer "default", else first env, else leave as-is (resolve will report).
          if (this.envs.default) this.activeEnv = 'default';
          else if (this.availableEnvs[0]) this.activeEnv = this.availableEnvs[0];
        }
      }
    } catch {
      // No file is fine — empty env.
      this.envs = {};
      this.loadError = undefined;
    }
    this.render();
    this.emitter.fire();
  }

  async pickEnv(): Promise<void> {
    const envs = this.availableEnvs;
    if (envs.length === 0) {
      vscode.window.showInformationMessage(
        'Reqit: no environments defined. Run "Reqit: Init Workspace" to scaffold one.',
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(
      envs.map((name) => ({
        label: name,
        description: name === this.activeEnv ? '(active)' : undefined,
      })),
      { placeHolder: 'Select Reqit environment' },
    );
    if (!pick) return;
    await this.setActive(pick.label);
  }

  async setActive(name: string): Promise<void> {
    this.activeEnv = name;
    await this.context.workspaceState.update(ACTIVE_ENV_KEY, name);
    this.render();
    this.emitter.fire();
  }

  /**
   * Build a resolver closure for the active env, pre-fetching any secrets so
   * substitution stays synchronous.
   */
  async buildResolver(): Promise<(name: string) => string | undefined> {
    const env: Env = this.envs[this.activeEnv] ?? {};
    const secrets = new Map<string, string>();
    for (const [varName, value] of Object.entries(env)) {
      if (!isSecretMarker(value)) continue;
      const stored = await this.getSecret(this.activeEnv, varName);
      const finalValue =
        stored ?? (await this.promptAndStoreSecret(this.activeEnv, varName));
      if (finalValue !== undefined) secrets.set(varName, finalValue);
    }
    return (name) => {
      if (secrets.has(name)) return secrets.get(name);
      const v = env[name];
      if (v === undefined) return undefined;
      if (isSecretMarker(v)) return undefined; // prompt was cancelled
      return String(v);
    };
  }

  /** Force-prompt for a secret and overwrite the stored value. */
  async setSecret(envName: string, varName: string): Promise<void> {
    await this.promptAndStoreSecret(envName, varName, { force: true });
  }

  /** Returns metadata about all declared secrets across envs. */
  listSecrets(): Array<{ env: string; name: string }> {
    return listSecretVars(this.envs);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private envFileUri(): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    return vscode.Uri.joinPath(folder.uri, '.requests', '.http-env.json');
  }

  private secretKey(envName: string, varName: string): string {
    return `${SECRET_PREFIX}${envName}.${varName}`;
  }

  private async getSecret(envName: string, varName: string): Promise<string | undefined> {
    return this.context.secrets.get(this.secretKey(envName, varName));
  }

  private async promptAndStoreSecret(
    envName: string,
    varName: string,
    opts: { force?: boolean } = {},
  ): Promise<string | undefined> {
    if (!opts.force) {
      const existing = await this.getSecret(envName, varName);
      if (existing !== undefined) return existing;
    }
    const value = await vscode.window.showInputBox({
      title: `Reqit secret: ${envName}.${varName}`,
      prompt: 'Stored in VS Code SecretStorage. Never written to disk in plaintext.',
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return undefined;
    await this.context.secrets.store(this.secretKey(envName, varName), value);
    return value;
  }

  private render(): void {
    if (this.loadError) {
      this.statusItem.text = `$(warning) Reqit: env error`;
      this.statusItem.tooltip = `Failed to load .http-env.json: ${this.loadError}`;
      return;
    }
    const known = this.availableEnvs.includes(this.activeEnv);
    const icon = known ? '$(symbol-namespace)' : '$(question)';
    this.statusItem.text = `${icon} Reqit: ${this.activeEnv}`;
    this.statusItem.tooltip = known
      ? 'Reqit environment — click to switch'
      : `Active env "${this.activeEnv}" is not defined in .http-env.json`;
  }
}
