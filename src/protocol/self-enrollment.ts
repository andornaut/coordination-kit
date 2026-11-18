// A registered role enrolls itself from its own journal, registry binding and canonical
// references, through the existing enrollment producer and receipt format.
import { isDeepStrictEqual } from "node:util";

import type { Io } from "../io.ts";
import type { Layout } from "../layout.ts";
import { resolveConversation, resolveHarness } from "../registry/resolve.ts";
import { readRegistry } from "../registry/store.ts";
import { canonical, type ProtocolStore } from "./core.ts";
import {
  type EnrollmentContext,
  EnrollmentError,
  type EnrollmentInput,
  EnrollmentStore,
} from "./enrollment.ts";
import { type EnrollmentScopeInput, enrollmentStatus } from "./enrollment-runtime.ts";
import { protocolRole, resolveProtocolBinding } from "./runtime.ts";
import type { Binding } from "./types.ts";

/** The variable each harness exports with the current conversation's native ID. */
export const NATIVE_ID_ENV = {
  claude: "CLAUDE_CODE_SESSION_ID",
  codex: "CODEX_THREAD_ID",
} as const satisfies Record<Binding["harness"], string>;

export interface SelfEnrollmentRequest {
  /** The registry role name, as `protocol boundary --role` takes it. */
  readonly role: string;
  readonly at: string;
  /** The caller's native ID; otherwise it is read from the harness's `NATIVE_ID_ENV` variable. */
  readonly nativeId?: string;
}

/** What the command checked, recorded in the inspection evidence. */
const VERIFIED = [
  "registered-role",
  "registry-effective-binding",
  "caller-native-id-matches-binding",
  "journal-binding-matches-registry",
  "supported-binding-resolution",
] as const;
/** What it did not check; those scopes stay explicit UNKNOWNs or limits. */
const NOT_VERIFIED = [
  "caller-process-identity",
  "native-history",
  "external-wip",
  "worker-census",
] as const;

function unverified(): never {
  throw new EnrollmentError("enrollment-caller-unverified");
}

/**
 * The binding the caller may enroll under: the role's registered effective binding, provided the
 * caller's supplied or detected native ID equals it. The native ID is the caller's assertion; it
 * is compared, not authenticated.
 */
async function callerBinding(
  io: Pick<Io, "env">,
  layout: Layout,
  namespace: string,
  request: SelfEnrollmentRequest,
): Promise<Binding> {
  const registry = readRegistry(layout);
  const harness = resolveHarness(registry, request.role);
  const registered = resolveConversation(registry, request.role);
  const detected = io.env[NATIVE_ID_ENV[harness]] || undefined;
  if (
    registered === null ||
    (request.nativeId !== undefined && detected !== undefined && request.nativeId !== detected)
  ) {
    unverified();
  }
  const binding: Binding = { harness, nativeId: request.nativeId ?? detected ?? unverified() };
  if (
    binding.nativeId !== registered ||
    !(await resolveProtocolBinding(layout, io, namespace, binding))
  ) {
    unverified();
  }
  return binding;
}

/**
 * Claim the first epoch when the journal is unclaimed, then publish an active or prepared receipt
 * that lists every canonical reference known for the role and retains each required UNKNOWN scope.
 * A journal held under another binding needs an explicit `protocol claim` first.
 */
export async function enrollSelf(
  io: Pick<Io, "env">,
  layout: Layout,
  protocol: ProtocolStore,
  base: Omit<EnrollmentScopeInput, "census" | "role">,
  request: SelfEnrollmentRequest,
) {
  if (!Number.isFinite(Date.parse(request.at))) {
    throw new EnrollmentError("invalid-enrollment");
  }
  let namespace: string;
  try {
    namespace = protocolRole(layout, request.role);
  } catch {
    unverified();
  }
  const binding = await callerBinding(io, layout, namespace, request);
  let state = protocol.read(namespace);
  const claimed =
    state.epoch === 0
      ? await protocol.claim({
          at: request.at,
          binding,
          evidence: `enroll-self:${namespace}`,
          expectedEpoch: 0,
          role: namespace,
        })
      : null;
  state = protocol.read(namespace);
  if (!isDeepStrictEqual(state.binding, binding)) {
    throw new EnrollmentError("enrollment-claim-required");
  }
  const own = { ...base, census: [], role: namespace };
  const { scope } = enrollmentStatus(layout, protocol, own);
  const participant = scope.participants.find((value) => value.role === namespace);
  if (participant === undefined) {
    throw new EnrollmentError("enrollment-roster-mismatch");
  }
  const ledger = scope.ledgerAnchors.at(-1)!;
  const parentRole = participant.parentRole ?? namespace;
  const evidence = await protocol.putArtifact(
    Buffer.from(
      canonical({
        binding,
        command: "protocol enroll-self",
        epoch: state.epoch,
        generation: scope.generation,
        inspectedAt: request.at,
        journal: { hash: state.hash, revision: state.revision },
        ledger,
        notVerified: NOT_VERIFIED,
        phase: scope.phase,
        references: participant.knownReferences,
        registryRevision: scope.registryRevision,
        requiredUnknownScopes: participant.requiredUnknownScopes,
        role: namespace,
        verified: VERIFIED,
        workspaceId: scope.workspaceId,
      }),
    ),
  );
  const context: EnrollmentContext = {
    at: request.at,
    binding,
    epoch: state.epoch,
    expectedRevision: state.revision,
    id: `enroll-self-${state.epoch}-${state.revision}`,
    role: namespace,
  };
  const input: EnrollmentInput = {
    evidence: [evidence],
    generation: scope.generation,
    inspectedAt: request.at,
    ledger,
    phase: scope.phase,
    references: participant.knownReferences,
    registryRevision: scope.registryRevision,
    unknowns: participant.requiredUnknownScopes.map((value) => ({
      evidence: [evidence],
      id: `enroll-self-${value}`,
      nextBoundary: "next own enrollment, startup, resume or review",
      parentRole,
      participantRole: namespace,
      reason: `protocol enroll-self reads canonical protocol state only; ${value} was not inspected`,
      scope: value,
    })),
    workspaceId: scope.workspaceId,
  };
  const event = await new EnrollmentStore({ protocol }).publish(context, input, scope);
  return { claimed, context, event, input, ...enrollmentStatus(layout, protocol, own) };
}
