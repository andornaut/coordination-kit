// The writer fence: a caller is the registry role whose effective harness conversation ID equals
// the caller's native ID. An opt-in proof port can bind a Codex child from its environment
// beneath an exact registered parent. `--worker` is attribution only.
import { isCanonicalUuid } from "../../core/ids.ts";
import { CONVERSATION_ID_PATTERN } from "../../core/validate.ts";
import { resolveConversation, resolveHarness } from "../../registry/resolve.ts";
import type { Harness, Registry } from "../../registry/schema.ts";
import { type Actor, StoreError } from "../types.ts";

/** The environment variable each harness sets to the running conversation's native ID. */
export const NATIVE_ID_VARIABLES: Readonly<Record<Harness, string>> = {
  claude: "CLAUDE_CODE_SESSION_ID",
  codex: "CODEX_THREAD_ID",
};

/** The runner's role in the registry, the sender of every message the kit stores for it. */
export const DELIVERY_KIT_ROLE = "delivery-kit";
export const DELIVERY_KIT_ACTOR: Actor = { nativeId: null, role: DELIVERY_KIT_ROLE };

const WORKER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface VerifiedWorkerCaller {
  readonly parentRole: string;
  readonly parentNativeId: string;
  readonly workerNativeId: string;
  readonly registryRevision: number;
  readonly evidenceSha256: string;
}

/** A trusted, synchronous proof source supplied by the coordination authority. */
type WorkerProof = (nativeId: string) => VerifiedWorkerCaller | null;

/** Require the exact active Codex parent and an unambiguous worker outside registered roles. */
export function matchesVerifiedWorker(
  registry: Registry,
  nativeId: string,
  proof: VerifiedWorkerCaller,
): boolean {
  const parent = Object.hasOwn(registry.roles, proof.parentRole)
    ? registry.roles[proof.parentRole]
    : undefined;
  if (
    parent === undefined ||
    parent.ownership !== "active" ||
    parent.phase === "held" ||
    parent.phase === "source-held" ||
    proof.registryRevision !== registry.revision ||
    !SHA256.test(proof.evidenceSha256) ||
    nativeId !== proof.workerNativeId ||
    !isCanonicalUuid(nativeId) ||
    !isCanonicalUuid(proof.parentNativeId) ||
    resolveHarness(registry, proof.parentRole) !== "codex" ||
    resolveConversation(registry, proof.parentRole) !== proof.parentNativeId
  ) {
    return false;
  }
  const bindings = Object.keys(registry.roles)
    .filter((role) => resolveHarness(registry, role) === "codex")
    .map((role) => resolveConversation(registry, role));
  return (
    !bindings.includes(nativeId) &&
    bindings.filter((id) => id === proof.parentNativeId).length === 1
  );
}

export interface CallerOptions {
  /** An explicit native ID, used instead of the harness environment variable. */
  readonly nativeId?: string;
  /** Unverified worker attribution, recorded beside the role. */
  readonly worker?: string;
}

/**
 * Match a registered caller or a Codex child proved by the opt-in port. Explicit IDs select
 * registered callers only. More than one effective match is ambiguous.
 */
export function resolveCaller(
  registry: Registry,
  env: NodeJS.ProcessEnv,
  options: CallerOptions = {},
  workerProof?: WorkerProof,
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
  if (
    workerProof !== undefined &&
    options.nativeId === undefined &&
    !matches.some(({ role }) => resolveHarness(registry, role) === "codex")
  ) {
    const child = env[NATIVE_ID_VARIABLES.codex];
    if (isCanonicalUuid(child)) {
      const proof = workerProof(child);
      if (proof != null && matchesVerifiedWorker(registry, child, proof)) {
        matches.push({ nativeId: child, role: proof.parentRole });
      }
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
