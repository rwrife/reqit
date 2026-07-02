/**
 * Descriptor index — resolves gRPC method FQNs to their input/output types
 * using an in-memory representation of `FileDescriptorProto` objects.
 *
 * Where the caller gets those descriptors from is intentionally out of
 * scope: the reflection transport (issue #24, next slice) will hand us
 * decoded descriptors; static `.proto` loading (future) will hand us the
 * same shape from `protobufjs`; tests build them synthetically.
 *
 * This module is pure, VS Code-free, transport-free, and zod-validates
 * every descriptor at the boundary. That way one malformed file from a
 * server can't crash the whole extension host.
 *
 * FQN handling notes:
 *   - Everything the index emits is fully-qualified with a leading `.`
 *     (e.g. `.foo.bar.User`), matching the descriptor convention.
 *   - Lookups accept both `.foo.bar.MyService/Do` and the leading-dot form.
 *   - Nested types (`Outer.Inner`) are flattened into the FQN space.
 *   - When a method's `input_type`/`output_type` is written as an unqualified
 *     name (rare but legal), we resolve it relative to the enclosing package,
 *     then walking up namespaces — same rules protoc uses.
 */

import { z } from 'zod';

/** Minimal JS shape mirroring the subset of `FileDescriptorProto` we care about. */
export const MethodDescriptorSchema = z.object({
  name: z.string().min(1),
  /** Type name; may be leading-dot FQN, dot-relative, or bare. */
  inputType: z.string().min(1),
  outputType: z.string().min(1),
  clientStreaming: z.boolean().optional().default(false),
  serverStreaming: z.boolean().optional().default(false),
  deprecated: z.boolean().optional().default(false),
});
export type MethodDescriptor = z.infer<typeof MethodDescriptorSchema>;

export const ServiceDescriptorSchema = z.object({
  name: z.string().min(1),
  methods: z.array(MethodDescriptorSchema).default([]),
  deprecated: z.boolean().optional().default(false),
});
export type ServiceDescriptor = z.infer<typeof ServiceDescriptorSchema>;

// Message type descriptors can nest, so schema is defined via z.lazy.
export type MessageDescriptor = {
  name: string;
  nested?: MessageDescriptor[];
};
export const MessageDescriptorSchema: z.ZodType<MessageDescriptor> = z.lazy(() =>
  z.object({
    name: z.string().min(1),
    nested: z.array(MessageDescriptorSchema).optional(),
  }),
);

export const FileDescriptorProtoSchema = z.object({
  /** File path, e.g. `users/v1/users.proto`. */
  name: z.string().min(1),
  /** Proto package, e.g. `users.v1`. May be empty. */
  package: z.string().optional().default(''),
  services: z.array(ServiceDescriptorSchema).default([]),
  messages: z.array(MessageDescriptorSchema).default([]),
});
export type FileDescriptorProto = z.infer<typeof FileDescriptorProtoSchema>;

/** Resolved method lookup result — everything a caller needs to encode a call. */
export interface ResolvedMethod {
  /** Fully-qualified service name with leading `.`, e.g. `.users.v1.UserService`. */
  serviceFqn: string;
  /** Bare method name, e.g. `ListUsers`. */
  methodName: string;
  /** Fully-qualified input type with leading `.`. */
  inputTypeFqn: string;
  /** Fully-qualified output type with leading `.`. */
  outputTypeFqn: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  /** True if either the service or the method is marked deprecated. */
  deprecated: boolean;
}

/**
 * Session-scoped index. Build once from the reflection cache output, then
 * call `findMethod` per send. `addFile` is idempotent per file `name`;
 * re-adding replaces the previous entry (matches how server reflection
 * would refresh a proto file after a schema change).
 */
export class DescriptorIndex {
  /** All known files, keyed by file `name`. */
  private readonly files = new Map<string, FileDescriptorProto>();
  /** Set of all fully-qualified message type names (`.pkg.Msg`, `.pkg.Outer.Inner`, …). */
  private readonly types = new Set<string>();
  /** service FQN (leading `.`) → ServiceDescriptor. */
  private readonly services = new Map<string, ServiceDescriptor>();

  /** Bulk-load an array of files. Later duplicates by `name` win. */
  static from(files: unknown[]): DescriptorIndex {
    const idx = new DescriptorIndex();
    for (const raw of files) {
      idx.addFile(raw);
    }
    return idx;
  }

  /** Add or replace a single file. Input is validated with zod. */
  addFile(raw: unknown): void {
    const file = FileDescriptorProtoSchema.parse(raw);
    // Remove any previous version of this file from the indexes first.
    const existing = this.files.get(file.name);
    if (existing) {
      this.dropFile(existing);
    }
    this.files.set(file.name, file);

    const pkg = file.package;
    for (const svc of file.services) {
      const fqn = joinFqn(pkg, svc.name);
      this.services.set(fqn, svc);
    }
    for (const msg of file.messages) {
      this.collectMessageFqns(pkg, msg);
    }
  }

  /** Remove a specific file by `name`, dropping any services/types it defined. */
  removeFile(name: string): void {
    const existing = this.files.get(name);
    if (!existing) return;
    this.dropFile(existing);
    this.files.delete(name);
  }

  /** Drop everything. */
  clear(): void {
    this.files.clear();
    this.types.clear();
    this.services.clear();
  }

  /** Number of loaded files (mostly useful for tests + debug). */
  get fileCount(): number {
    return this.files.size;
  }

  /** All known service FQNs, sorted for stable output. */
  listServices(): string[] {
    return [...this.services.keys()].sort();
  }

  /**
   * Resolve a `service/method` path to its fully-qualified pieces. The
   * service portion accepts:
   *   - Leading-dot FQN, e.g. `.users.v1.UserService`
   *   - Bare FQN, e.g. `users.v1.UserService`
   * The method portion is the bare method name (case-sensitive, per proto).
   *
   * Returns `undefined` when the service is unknown or the method isn't
   * defined on it. Throws `Error` if the input type or output type on the
   * method can't be resolved against the loaded types — that's a broken
   * descriptor set, not a routine miss.
   */
  findMethod(serviceOrPath: string, method?: string): ResolvedMethod | undefined {
    let serviceRaw: string;
    let methodName: string;

    if (method === undefined) {
      const slash = serviceOrPath.indexOf('/');
      if (slash < 0) return undefined;
      serviceRaw = serviceOrPath.slice(0, slash);
      methodName = serviceOrPath.slice(slash + 1);
    } else {
      serviceRaw = serviceOrPath;
      methodName = method;
    }
    if (serviceRaw.length === 0 || methodName.length === 0) return undefined;

    const serviceFqn = ensureLeadingDot(serviceRaw);
    const svc = this.services.get(serviceFqn);
    if (!svc) return undefined;

    const m = svc.methods.find((mm) => mm.name === methodName);
    if (!m) return undefined;

    const pkg = fqnPackage(serviceFqn);
    const inputTypeFqn = this.resolveType(pkg, m.inputType);
    if (!inputTypeFqn) {
      throw new Error(
        `Method ${serviceFqn}/${m.name} references unknown input type "${m.inputType}"`,
      );
    }
    const outputTypeFqn = this.resolveType(pkg, m.outputType);
    if (!outputTypeFqn) {
      throw new Error(
        `Method ${serviceFqn}/${m.name} references unknown output type "${m.outputType}"`,
      );
    }

    return {
      serviceFqn,
      methodName: m.name,
      inputTypeFqn,
      outputTypeFqn,
      clientStreaming: m.clientStreaming,
      serverStreaming: m.serverStreaming,
      deprecated: svc.deprecated || m.deprecated,
    };
  }

  /**
   * Look up a fully-qualified message type. Accepts either the leading-dot
   * or bare form. Returns the canonical leading-dot FQN when known.
   */
  hasType(name: string): boolean {
    return this.types.has(ensureLeadingDot(name));
  }

  // ---- internals ----------------------------------------------------------

  private dropFile(file: FileDescriptorProto): void {
    const pkg = file.package;
    for (const svc of file.services) {
      const fqn = joinFqn(pkg, svc.name);
      // Only drop if it still points at this exact file's service — avoids
      // clobbering an unrelated service that happens to share a name in a
      // different file. In protobuf that's a rebind error anyway, but be safe.
      const cur = this.services.get(fqn);
      if (cur === svc) this.services.delete(fqn);
    }
    for (const msg of file.messages) {
      this.forEachMessageFqn(pkg, msg, (fqn) => this.types.delete(fqn));
    }
  }

  private collectMessageFqns(prefix: string, msg: MessageDescriptor): void {
    this.forEachMessageFqn(prefix, msg, (fqn) => this.types.add(fqn));
  }

  private forEachMessageFqn(
    prefix: string,
    msg: MessageDescriptor,
    visit: (fqn: string) => void,
  ): void {
    const fqn = joinFqn(prefix, msg.name);
    visit(fqn);
    if (msg.nested) {
      // Nested messages inherit the outer FQN as their package prefix
      // (with leading dot stripped for join semantics).
      const inner = fqn.replace(/^\./, '');
      for (const child of msg.nested) {
        this.forEachMessageFqn(inner, child, visit);
      }
    }
  }

  /**
   * Resolve a type reference the way protoc does:
   *   - `.foo.bar.Baz` → exact FQN, take it as-is
   *   - `foo.bar.Baz`  → try `.<pkg>.foo.bar.Baz`, walking up each parent
   *     scope, then the root
   * Returns the canonical leading-dot FQN on success, or `undefined`.
   */
  private resolveType(pkg: string, ref: string): string | undefined {
    if (ref.startsWith('.')) {
      return this.types.has(ref) ? ref : undefined;
    }
    // Walk from the innermost scope outward.
    const scopes = pkg.length === 0 ? [''] : buildScopeChain(pkg);
    for (const scope of scopes) {
      const candidate = joinFqn(scope, ref);
      if (this.types.has(candidate)) return candidate;
    }
    return undefined;
  }
}

// ---- helpers --------------------------------------------------------------

function ensureLeadingDot(fqn: string): string {
  return fqn.startsWith('.') ? fqn : `.${fqn}`;
}

/** Join a package and a name into a `.package.name` FQN. */
function joinFqn(pkg: string, name: string): string {
  if (pkg.length === 0) return `.${name}`;
  return `.${pkg}.${name}`;
}

/** For `foo.bar.baz` returns [`foo.bar.baz`, `foo.bar`, `foo`, ``]. */
function buildScopeChain(pkg: string): string[] {
  const parts = pkg.split('.');
  const chain: string[] = [];
  for (let i = parts.length; i >= 0; i--) {
    chain.push(parts.slice(0, i).join('.'));
  }
  return chain;
}

/** For `.foo.bar.MyService` returns `foo.bar`. */
function fqnPackage(fqn: string): string {
  const stripped = fqn.replace(/^\./, '');
  const lastDot = stripped.lastIndexOf('.');
  return lastDot < 0 ? '' : stripped.slice(0, lastDot);
}
