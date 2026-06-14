/**
 * Pure `.http-env.json` parser & schema. No VS Code dependencies.
 *
 * Shape:
 * {
 *   "default": { "baseUrl": "https://api.example.com" },
 *   "staging": {
 *     "baseUrl": "https://staging.example.com",
 *     "apiKey": { "$secret": true }
 *   }
 * }
 *
 * A value is either a plain scalar (string/number/boolean) or a secret marker
 * object `{ "$secret": true }`. Secret values are resolved later via
 * VS Code SecretStorage — never stored on disk in plaintext.
 */
import { z } from 'zod';

export const secretMarkerSchema = z.object({ $secret: z.literal(true) });

export const envValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  secretMarkerSchema,
]);

export const envSchema = z.record(z.string(), envValueSchema);

export const envFileSchema = z.record(z.string(), envSchema);

export type SecretMarker = z.infer<typeof secretMarkerSchema>;
export type EnvValue = z.infer<typeof envValueSchema>;
export type Env = z.infer<typeof envSchema>;
export type EnvFile = z.infer<typeof envFileSchema>;

export function isSecretMarker(v: unknown): v is SecretMarker {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).$secret === true
  );
}

export interface ParseEnvFileResult {
  ok: boolean;
  envs: EnvFile;
  error?: string;
}

/** Parse and validate `.http-env.json` source text. Never throws. */
export function parseEnvFile(source: string): ParseEnvFileResult {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (err) {
    return { ok: false, envs: {}, error: `Invalid JSON: ${(err as Error).message}` };
  }
  const parsed = envFileSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, envs: {}, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, envs: parsed.data };
}

/** List secret variable names declared anywhere in the env file. */
export function listSecretVars(envs: EnvFile): Array<{ env: string; name: string }> {
  const out: Array<{ env: string; name: string }> = [];
  for (const [envName, env] of Object.entries(envs)) {
    for (const [varName, value] of Object.entries(env)) {
      if (isSecretMarker(value)) out.push({ env: envName, name: varName });
    }
  }
  return out;
}
