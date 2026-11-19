// The writer fence: a caller is the registry role whose effective harness conversation ID equals
// the caller's native ID. The ID is `--native-id`, else the environment variable of each role's
// effective harness. No epochs, claims or enrollment take part. `--worker` is attribution only.
import { resolveConversation, resolveHarness } from "../registry/resolve.ts";
import type { Harness, Registry } from "../registry/schema.ts";
import { CONVERSATION_ID_PATTERN } from "../validate.ts";
import { type Actor, StoreError } from "./types.ts";

/** The environment variable each harness sets to the running conversation's native ID. */
export const NATIVE_ID_VARIABLES: Readonly<Record<Harness, string>> = {
  claude: "CLAUDE_CODE_SESSION_ID",
  codex: "CODEX_THREAD_ID",
};

const WORKER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface CallerOptions {
  /** An explicit native ID, used instead of the harness environment variable. */
  readonly nativeId?: string;
  /** Unverified worker attribution, recorded beside the role. */
  readonly worker?: string;
}

/**
 * The caller's role and native ID. Refuses `caller-unidentified` when no native ID is given or
 * set, `caller-unbound` when no role's effective binding matches, and `caller-ambiguous` when
 * more than one does.
 */
export function resolveCaller(
  registry: Registry,
  env: NodeJS.ProcessEnv,
  options: CallerOptions = {},
): Actor & { readonly role: string; readonly nativeId: string } {
  if (options.worker !== undefined && !WORKER.test(options.worker)) {
    throw new StoreError("invalid-worker");
  }
  if (options.nativeId !== undefined && !CONVERSATION_ID_PATTERN.test(options.nativeId)) {
    throw new StoreError("invalid-native-id");
  }
  const variables = Object.values(NATIVE_ID_VARIABLES).filter((name) => env[name]);
  if (options.nativeId === undefined && variables.length === 0) {
    throw new StoreError("caller-unidentified");
  }
  const matches: { role: string; nativeId: string }[] = [];
  for (const role of Object.keys(registry.roles).sort()) {
    const bound = resolveConversation(registry, role);
    const claimed = options.nativeId ?? env[NATIVE_ID_VARIABLES[resolveHarness(registry, role)]];
    if (bound !== null && claimed !== undefined && claimed === bound) {
      matches.push({ nativeId: bound, role });
    }
  }
  if (matches.length === 0) {
    throw new StoreError("caller-unbound");
  }
  if (matches.length > 1) {
    throw new StoreError("caller-ambiguous");
  }
  const [{ nativeId, role }] = matches as [{ role: string; nativeId: string }];
  return { nativeId, role, ...(options.worker === undefined ? {} : { worker: options.worker }) };
}
