// Inspect a built package without claiming that its source snapshot is an immutable commit.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain, node, run } from "./check.ts";

export interface CheckContext {
  readonly CHECK_REVISION: string;
  readonly CHECK_SOURCE_SHA256: string;
  readonly CHECK_SOURCE_DIRTY: boolean;
}

export function checkContext(env: Readonly<Record<string, string | undefined>>): CheckContext {
  const { CHECK_REVISION, CHECK_SOURCE_SHA256, CHECK_SOURCE_DIRTY } = env;
  if (
    CHECK_REVISION === undefined ||
    !/^[0-9a-f]{40}$/.test(CHECK_REVISION) ||
    CHECK_SOURCE_SHA256 === undefined ||
    !/^[0-9a-f]{64}$/.test(CHECK_SOURCE_SHA256) ||
    (CHECK_SOURCE_DIRTY !== "true" && CHECK_SOURCE_DIRTY !== "false")
  ) {
    throw new Error("container snapshot provenance is missing or invalid");
  }
  return { CHECK_REVISION, CHECK_SOURCE_SHA256, CHECK_SOURCE_DIRTY: CHECK_SOURCE_DIRTY === "true" };
}

export function inspectionContext(env: Readonly<Record<string, string | undefined>>) {
  const supplied = ["CHECK_REVISION", "CHECK_SOURCE_SHA256", "CHECK_SOURCE_DIRTY"].some(
    (key) => env[key] !== undefined,
  );
  return {
    kind: "snapshot-package-inspection" as const,
    immutableCommitClaim: false as const,
    ...(supplied ? checkContext(env) : {}),
  };
}

// The package ships the topic docs and the design summaries; the work files stay in the repository.
export function packagedDocs(root: string): string[] {
  const topics = readdirSync(join(root, "docs"), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `docs/${entry.name}`);
  const design = readdirSync(join(root, "docs", "design")).map((name) => `docs/design/${name}`);
  return [...topics, ...design].sort();
}

export function inspectPackage(
  env: Readonly<Record<string, string | undefined>>,
  root: string,
): void {
  const context = inspectionContext(env);
  const proof = mkdtempSync(join(tmpdir(), "coordination-kit-package-check-"));
  const packed = spawnSync(
    "npm",
    ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", proof],
    { cwd: root, encoding: "utf8" },
  );
  if (packed.status !== 0) throw new Error("package inspection failed: " + packed.stderr);
  const [metadata] = JSON.parse(packed.stdout) as [{ filename: string }];
  const archive = join(proof, metadata.filename),
    extracted = join(proof, "unpacked");
  mkdirSync(extracted);
  run(root, "tar", ["-xzf", archive, "-C", extracted]);
  const pkg = join(extracted, "package");
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as {
    version: string;
    exports: Record<string, string | { types: string; import: string }>;
  };
  if (manifest.version !== readFileSync(join(root, "VERSION"), "utf8").trim())
    throw new Error("package version differs from VERSION");
  for (const doc of packagedDocs(root))
    if (!existsSync(join(pkg, doc))) throw new Error(`package ${doc} is missing`);
  if (existsSync(join(pkg, "docs", "work"))) throw new Error("package must not contain docs/work");
  const version = spawnSync(process.execPath, [join(pkg, "dist/cli.js"), "--version"], {
    encoding: "utf8",
  });
  if (version.status !== 0 || version.stdout.trim() !== manifest.version)
    throw new Error("package CLI version differs from package.json");
  const modules = ["accounting", "events", "protocol", "registry", "review", "shared", "transport"];
  const expectedExports = ["./package.json", ...modules.map((name) => `./build/${name}`)].sort();
  if (JSON.stringify(Object.keys(manifest.exports).sort()) !== JSON.stringify(expectedExports))
    throw new Error("package must export only explicit build APIs and metadata");
  if (manifest.exports["./package.json"] !== "./package.json")
    throw new Error("package metadata export differs");
  for (const name of modules) {
    const path = `./build/${name}`;
    const entry = manifest.exports[path];
    if (
      entry === undefined ||
      typeof entry === "string" ||
      entry.types !== `./dist/${name}.d.ts` ||
      entry.import !== `./dist/${name}.js` ||
      JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["import", "types"]) ||
      !existsSync(join(pkg, entry.types)) ||
      !existsSync(join(pkg, entry.import))
    ) {
      throw new Error("package build API target differs: " + path);
    }
  }
  node(pkg, "--input-type=module", [
    "-e",
    "import { readRegistry, resolveConversation, updateRegistry, LockBusy } from '@andornaut/coordination-kit/build/registry'; " +
      "import * as shared from '@andornaut/coordination-kit/build/shared'; " +
      "if (![readRegistry, resolveConversation, updateRegistry].every(value => typeof value === 'function')) process.exit(1); " +
      "if (shared.LockBusy !== LockBusy) throw new Error('API subpaths must share module instances');",
  ]);
  node(pkg, "--input-type=module", [
    "-e",
    "import * as transport from '@andornaut/coordination-kit/build/transport'; " +
      "if (JSON.stringify(Object.keys(transport).sort()) !== JSON.stringify(['messageChannelStateDir', 'resolveCodexControlSocket'])) process.exit(1); " +
      "const { resolveCodexControlSocket, messageChannelStateDir } = transport; " +
      "const endpoint = resolveCodexControlSocket({ env: {}, home: '/fixture' }); " +
      "const channel = messageChannelStateDir({ reviewDir: '/review' }, '00000000-0000-4000-8000-000000000001'); " +
      "if (channel !== '/review/messages/recipients/00000000-0000-4000-8000-000000000001/unblock') process.exit(1); " +
      "if (endpoint.source !== 'managed' || endpoint.path !== '/fixture/.codex/app-server-control/app-server-control.sock') process.exit(1);",
  ]);
  node(pkg, "--input-type=module", [
    "-e",
    "import { LedgerStore, LedgerError, snapshotIntake, messageIntake, auditIntake, " +
      "captureAccounting, accountingStatus } from '@andornaut/coordination-kit/build/accounting'; " +
      "if (![LedgerStore, LedgerError, snapshotIntake, messageIntake, auditIntake, " +
      "captureAccounting, accountingStatus].every(value => typeof value === 'function')) process.exit(1);",
  ]);
  node(pkg, "--input-type=module", [
    "-e",
    "import { deliverScheduledReview, readRoleRoute, routeRecipient, DEFERRED_PREFIX } from '@andornaut/coordination-kit/build/review'; " +
      "import { flushEvents, recordEvent, enqueueEvent, eventsDir } from '@andornaut/coordination-kit/build/events'; " +
      "if (![deliverScheduledReview, readRoleRoute, routeRecipient, flushEvents, recordEvent, enqueueEvent, eventsDir]" +
      ".every(value => typeof value === 'function') || DEFERRED_PREFIX !== 'bus: review deferred: ') process.exit(1);",
  ]);
  const consumer = join(proof, "consumer");
  const scope = join(consumer, "node_modules", "@andornaut");
  mkdirSync(scope, { recursive: true });
  symlinkSync(pkg, join(scope, "coordination-kit"), "dir");
  const source = join(consumer, "consumer.mts");
  const consumerSource = `import {
  readRegistry, updateRegistry, RevisionConflict, type Registry, type Layout,
} from "@andornaut/coordination-kit/build/registry";
import {
  resolveCodexControlSocket, messageChannelStateDir, type CodexControlSocketEndpoint,
  type DeliveryDiagnostic, type NativeRpcCode,
} from "@andornaut/coordination-kit/build/transport";
import {
  deliverScheduledReview, readRoleRoute, type RoleRoute,
} from "@andornaut/coordination-kit/build/review";
import { flushEvents, recordEvent, type BusEvent, type EmitOptions } from "@andornaut/coordination-kit/build/events";
import {
  holdLock, loadProjectConfig, writeJsonDurable, type LockHandle, type ProjectConfig, type GameLayout,
} from "@andornaut/coordination-kit/build/shared";
import {
  LedgerStore, LedgerError, snapshotIntake, accountingStatus,
  type LedgerTransaction, type LedgerState, type IntakeContext,
} from "@andornaut/coordination-kit/build/accounting";
import { ProtocolStore, WorkStore, ProtocolMessages, resolveProtocolLayout, EnrollmentStore, resolveProtocolManagement, resolveEnrollmentScope,
 type ProtocolWriter, type WorkEvaluation, type ProtocolLayout } from "@andornaut/coordination-kit/build/protocol";
const protocolClaim = (store: ProtocolStore, writer: ProtocolWriter) => store.withWriter(writer, () => 1);
const protocolLayout: ProtocolLayout | null = null;
// @ts-expect-error Writer epochs remain numeric.
const invalidEpoch: ProtocolWriter["epoch"] = "1";
export { protocolClaim, protocolLayout, invalidEpoch, WorkStore, ProtocolMessages, resolveProtocolLayout, EnrollmentStore, resolveProtocolManagement, resolveEnrollmentScope };
export type { WorkEvaluation };
const ledgerState: LedgerState = "checked";
const ledgerCommit = (store: LedgerStore, input: LedgerTransaction) => store.apply(input);
const ledgerIntake = (context: IntakeContext) => snapshotIntake(context, {});
const ledgerReadiness = (layout: Layout) => accountingStatus(layout);
// @ts-expect-error Accounting states remain a finite union.
const invalidLedgerState: LedgerState = "native-accepted-means-complete";
// @ts-expect-error Ledger revisions must remain numbers, not untyped JSON.
const invalidLedgerRevision: LedgerTransaction["expectedRevision"] = "1";
export { LedgerStore, LedgerError, ledgerState, ledgerCommit, ledgerIntake, ledgerReadiness,
  invalidLedgerState, invalidLedgerRevision };
const endpoint: CodexControlSocketEndpoint = resolveCodexControlSocket({ env: {}, home: "/fixture" });
const channel: string = messageChannelStateDir(
  { reviewDir: "/review" }, "00000000-0000-4000-8000-000000000001",
);
const rpcCode: NativeRpcCode = -32000;
const diagnostic: DeliveryDiagnostic = {
  stage: "native-send", category: "rpc-refusal", classification: "native-rejected",
  method: "thread/queue/add", rpcCode,
};
const localDiagnostic: DeliveryDiagnostic = {
  stage: "local", category: "decision-clearance", classification: "guarded",
};
const diagnosticFields: Record<keyof DeliveryDiagnostic, true> = {
  stage: true, category: true, classification: true, method: true, rpcCode: true,
};
// @ts-expect-error Public diagnostic stages remain a finite union, not any or string.
const wrongStage: DeliveryDiagnostic["stage"] = "raw-native-stage";
// @ts-expect-error Public diagnostic categories cannot expose arbitrary native messages.
const wrongCategory: DeliveryDiagnostic["category"] = "raw-native-message";
// @ts-expect-error Classifications retain the finite safe diagnostic contract.
const wrongClassification: DeliveryDiagnostic["classification"] = "raw-native-classification";
// @ts-expect-error Methods cannot expose arbitrary native method names.
const wrongMethod: DeliveryDiagnostic["method"] = "private/native-method";
// @ts-expect-error Unknown native codes are omitted, not widened to arbitrary numbers.
const wrongRpcCode: NativeRpcCode = -31999;
const revision: (registry: Registry) => number = registry => registry.revision;
// @ts-expect-error Registry declarations must preserve the numeric revision type.
const wrongRevision: (registry: Registry) => string = registry => registry.revision;
// @ts-expect-error Endpoint sources must remain a finite union rather than any.
const wrongSource: "other" = endpoint.source;
// @ts-expect-error The named transport export requires a string conversation ID.
messageChannelStateDir({ reviewDir: "/review" }, 42);
const review = (layout: Layout, game: GameLayout): Promise<string> => deliverScheduledReview(layout, game, 0);
// @ts-expect-error A review slot is an epoch-seconds number.
deliverScheduledReview({} as Layout, {} as GameLayout, "0");
const route = (layout: Layout): RoleRoute | null => readRoleRoute(layout);
const flush = (game: GameLayout): Promise<void> => flushEvents(game);
const emit: EmitOptions = { project: "Fixture", underLock: (directory: string) => void directory };
const record = (game: GameLayout) => recordEvent(game, emit, "push", "key", "message");
const sent = (event: BusEvent): boolean => event.sent;
const lock: (path: string) => LockHandle = (path) => holdLock(path);
const project = (path: string): ProjectConfig["reports"] => loadProjectConfig(path).reports;
const durable = (path: string) => writeJsonDurable(path, {});
export { channel, endpoint, revision, wrongRevision, wrongSource, readRegistry, updateRegistry, RevisionConflict,
  review, route, flush, record, sent, lock, project, durable,
  diagnostic, localDiagnostic, diagnosticFields, rpcCode };
`;
  writeFileSync(source, consumerSource);

  node(consumer, join(root, "node_modules/typescript/bin/tsc"), [
    "--noEmit",
    "--strict",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2024",
    "--types",
    "node",
    "--typeRoots",
    join(root, "node_modules/@types"),
    source,
  ]);
  const result = {
    version: 1,
    ...context,
    packageVersion: manifest.version,
    archive: metadata.filename,
    archiveSha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
    cliVersion: version.stdout.trim(),
    nodeNextExports: {
      source: "extracted-package",
      canonicalSpecifiers: modules.map((name) => `@andornaut/coordination-kit/build/${name}`),
      classification: "node-build-operations-only",
      status: "passed",
    },
    SOURCE_DATE_EPOCH: env.SOURCE_DATE_EPOCH ?? null,
  };
  writeFileSync(join(proof, "CHECK_CONTEXT.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ ...result, inspectionDirectory: proof }));
}

if (isMain(import.meta.url)) {
  try {
    inspectPackage(process.env, resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  } catch (error) {
    console.error("package-check: " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
