import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { proveOwnerResolution, type Resolution } from "../adapters/codex/guard.ts";
import { connectControl } from "../adapters/codex/rpc.ts";
import {
  decisionDirectory,
  type DecisionMarkerInspection,
  inspectDecisionRecord,
} from "../adapters/shared/decisions.ts";
import { resolveCodexControlSocket } from "../adapters/shared/endpoints.ts";
import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import { isRecord, sameJson } from "../adapters/shared/pyjson.ts";
import { writeDurable } from "../durable.ts";
import { LockBusy, withLock } from "../lock.ts";
import { resolveHarness } from "../registry/resolve.ts";
import { resolveCaller } from "./identity.ts";
import { registry, type StoreServiceContext } from "./service.ts";
import { StoreError } from "./types.ts";

const DIGEST = /^[a-f0-9]{64}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function binding(context: StoreServiceContext) {
  const roles = registry(context);
  const { nativeId, role } = resolveCaller(roles, context.env);
  const entry = roles.roles[role]!;
  if (
    resolveHarness(roles, role) !== "codex" ||
    !isCanonicalUuid(nativeId) ||
    entry.ownership !== "active" ||
    entry.phase === "held" ||
    entry.phase === "source-held"
  ) {
    throw new StoreError("decision-owner-unavailable");
  }
  const base = decisionDirectory(context.layout, role);
  if (base === null) {
    throw new StoreError("decision-directory-unavailable");
  }
  return { directory: join(base, "decisions"), nativeId, revision: roles.revision, role };
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshot(path: string, nativeId: string) {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        digest: "absent",
        inspected: { record: null, state: "absent" } as const,
        mode: 0o600,
      };
    }
    throw new StoreError("decision-marker-unreadable");
  }
  let mode: number;
  let bytes: Buffer;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new StoreError("decision-marker-unreadable");
    }
    mode = stat.mode & 0o777;
    bytes = readFileSync(fd);
  } catch {
    throw new StoreError("decision-marker-unreadable");
  } finally {
    closeSync(fd);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    const inspected: DecisionMarkerInspection = { reason: "json", record: null, state: "invalid" };
    return { digest: sha256(bytes), inspected, mode };
  }
  return { digest: sha256(bytes), inspected: inspectDecisionRecord(value, nativeId), mode, value };
}

export function ownerDecisionMarker(context: StoreServiceContext) {
  const { directory, nativeId, revision, role } = binding(context);
  const { digest, inspected } = snapshot(join(directory, `${nativeId}.json`), nativeId);
  const diagnostic =
    inspected.state === "invalid"
      ? {
          ...(inspected.fields === undefined ? {} : { fields: inspected.fields }),
          reason: inspected.reason,
        }
      : {};
  return { ...diagnostic, digest, revision, role, schema: 1 as const, state: inspected.state };
}

function nextMarker(value: unknown, nativeId: string, resolution: Resolution) {
  if (
    !isRecord(value) ||
    value.thread_id !== nativeId ||
    (value.state !== "clear" && value.state !== "pending")
  ) {
    throw new StoreError("decision-marker-invalid");
  }
  const rows = Object.hasOwn(value, "resolutions") ? value.resolutions : [];
  if (!Array.isArray(rows)) {
    throw new StoreError("decision-marker-invalid");
  }
  const matches = (rows as unknown[]).filter(
    (row) => isRecord(row) && row.question_item_id === resolution.question_item_id,
  );
  const previous = matches[0];
  if (
    matches.length > 1 ||
    (isRecord(previous) &&
      Object.entries(resolution).some(
        ([key, expected]) => previous[key] != null && previous[key] !== expected,
      ))
  ) {
    throw new StoreError("decision-resolution-conflict");
  }
  const row = { ...(isRecord(previous) ? previous : {}), ...resolution };
  const resolutions =
    previous === undefined
      ? [...rows, row]
      : rows.map((entry: unknown) => (entry === previous ? row : entry));
  const next = { ...value, resolutions };
  if (inspectDecisionRecord(next, nativeId).state !== value.state) {
    throw new StoreError("decision-marker-invalid");
  }
  return next;
}

export async function resolveOwnerDecision(
  context: StoreServiceContext,
  input: { readonly digest: string; readonly revision: number; readonly resolution: Resolution },
) {
  const { digest, resolution, revision } = input;
  if (
    !DIGEST.test(digest) ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Object.values(resolution).every((id) => REFERENCE.test(id)) ||
    resolution.question_turn_id !== resolution.answer_turn_id
  ) {
    throw new StoreError("decision-evidence-invalid");
  }
  const owner = binding(context);
  const { directory, nativeId, role } = owner;
  const path = join(directory, `${nativeId}.json`);
  const before = snapshot(path, nativeId);
  if (revision !== owner.revision || digest !== before.digest) {
    throw new StoreError("decision-marker-stale");
  }
  // Only a marker already declaring an owner state can receive a verified resolution.
  const prior = before.value;
  const next = nextMarker(prior, nativeId, resolution);
  try {
    const client = await (context.ports?.connect?.() ??
      connectControl(
        performance.now() + 15_000,
        resolveCodexControlSocket({ env: context.env }).path,
      ));
    try {
      if (!(await proveOwnerResolution(client, nativeId, resolution))) {
        throw new StoreError("decision-native-proof-unavailable");
      }
    } finally {
      client.close();
    }
  } catch {
    throw new StoreError("decision-native-proof-unavailable");
  }

  const checkCurrent = () => {
    if (!sameJson(binding(context), owner) || snapshot(path, nativeId).digest !== digest) {
      throw new StoreError("decision-marker-stale");
    }
  };
  try {
    return withLock(
      context.layout.registryLock,
      () =>
        withLock(
          join(context.layout.varDir, `decision-${nativeId}.lock`),
          () => {
            checkCurrent();
            if (sameJson(prior, next)) {
              return { digest, outcome: "unchanged", revision, role, schema: 1 as const };
            }
            const bytes = `${JSON.stringify(next, null, 2)}\n`;
            writeDurable(path, bytes, {
              mode: before.mode,
              onStage: (stage) => {
                if (stage === "synced") {
                  checkCurrent();
                }
              },
            });
            const written = sha256(bytes);
            if (snapshot(path, nativeId).digest !== written) {
              throw new StoreError("decision-marker-write-unverified");
            }
            return { digest: written, outcome: "written", revision, role, schema: 1 as const };
          },
          { nonBlocking: true },
        ),
      { nonBlocking: true },
    );
  } catch (error) {
    if (error instanceof LockBusy) {
      throw new StoreError("decision-marker-busy");
    }
    throw error;
  }
}
