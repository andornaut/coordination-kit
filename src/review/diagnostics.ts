// Scoped read-only diagnostics. Native transport health never proves activation or handling.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";

import { listingOrNull, recipientAvailability } from "../adapters/claude/agents.ts";
import { channelResolution } from "../adapters/claude/channelStatus.ts";
import { wakeFilePath } from "../adapters/claude/wakeFile.ts";
import { connectControl, type RpcClient } from "../adapters/codex/rpc.ts";
import { resolveCodexControlSocket } from "../adapters/shared/endpoints.ts";
import type { Layout } from "../core/configuration/layout.ts";
import { isRecord } from "../core/encoding/pyjson.ts";
import { readJsonIfExists } from "../core/files/durable.ts";
import { resolveConversation, resolveHarness } from "../registry/resolve.ts";
import type { Harness, Registry } from "../registry/schema.ts";
import { resolveSelectedRoles, type RoleSelection } from "../registry/selection.ts";

type DiagnosticStatus = "available" | "unavailable" | "unknown" | "held";
type DiagnosticLayer = "adapter" | "service" | "frontend" | "bridge" | "channel";
interface LayerDiagnostic {
  readonly status: DiagnosticStatus;
  readonly code: string;
}

interface RoleDiagnosis {
  readonly role: string;
  readonly effective_harness: Harness;
  readonly native_id: string | null;
  readonly endpoint: {
    readonly path: string | null;
    readonly source: "option" | "environment" | "managed" | "agents_listing" | "skipped";
  };
  readonly channel_reference: {
    readonly path: string;
    readonly source: "wake_file";
  } | null;
  readonly config_reference: { readonly path: string; readonly source: "registry" };
  /** Claude only: the channel MCP server's configured launch command against the stable path. */
  readonly channel_command: ChannelCommand | null;
  /** Claude only: what the running channel server reported in its status file. */
  readonly channel_server: ChannelServer | null;
  readonly layers: Record<DiagnosticLayer, LayerDiagnostic>;
  readonly native_session: LayerDiagnostic;
  readonly activation: "unknown";
  readonly native_hold: "unknown";
  readonly failed_layer: DiagnosticLayer | null;
  readonly recovery_owner: "delivery-kit" | "native-codex" | "native-claude" | null;
  readonly supported_next_action:
    "verify_endpoint_configuration" | "inspect_native_session" | "native_owner_required" | "none";
}

interface ChannelCommand {
  readonly status: "stable" | "unstable" | "unknown";
  readonly code:
    | "stable_path"
    | "command_not_stable_path"
    | "channel_config_missing"
    | "channel_config_unreadable"
    | "channel_server_not_configured";
  readonly config: string;
  readonly server: string | null;
  /** The configured executable and arguments. */
  readonly command: readonly string[] | null;
  readonly expected: readonly string[];
}

interface ChannelServer {
  readonly status: "reported" | "unknown";
  readonly code:
    "status_file_read" | "status_file_stale" | "status_file_missing" | "status_file_unreadable";
  /** The binding the status file names; null without a readable status file. */
  readonly conversation: string | null;
  readonly version: string | null;
  readonly distSha256: string | null;
  readonly startedAt: string | null;
  readonly pid: number | null;
  readonly argv: readonly string[] | null;
}

/** `node <root>/node_modules/@andornaut/coordination-kit/dist/cli.js --root <root> claude channel`. */
function stableChannelCommand(root: string): string[] {
  return [
    "node",
    join(root, "node_modules", "@andornaut", "coordination-kit", "dist", "cli.js"),
    "--root",
    root,
    "claude",
    "channel",
  ];
}

function channelArgs(args: readonly unknown[]): boolean {
  return args.some((arg, index) => arg === "claude" && args[index + 1] === "channel");
}

/**
 * Compare the configured channel server's launch command with the stable path. Read-only: the
 * config is read, never written, and no server is contacted. Anything unreadable is unknown.
 */
function channelCommand(layout: Layout): ChannelCommand {
  const config = join(layout.varDir, "claude-channel.mcp.json");
  const expected = stableChannelCommand(layout.root);
  const base = { command: null, config, expected, server: null };
  if (!existsSync(config)) {
    return { ...base, code: "channel_config_missing", status: "unknown" };
  }
  let servers: [string, unknown][];
  try {
    const value = readJsonIfExists(config);
    servers = isRecord(value) && isRecord(value.mcpServers) ? Object.entries(value.mcpServers) : [];
  } catch {
    return { ...base, code: "channel_config_unreadable", status: "unknown" };
  }
  const found = servers.find(
    ([, server]) =>
      isRecord(server) &&
      typeof server.command === "string" &&
      Array.isArray(server.args) &&
      channelArgs(server.args),
  );
  if (found === undefined) {
    return { ...base, code: "channel_server_not_configured", status: "unknown" };
  }
  const [name, server] = found as [string, { command: string; args: unknown[] }];
  const command = [server.command, ...server.args.map(String)];
  const stable =
    basename(server.command) === "node" &&
    expected.slice(1).every((part, index) => command[index + 1] === part);
  return {
    code: stable ? "stable_path" : "command_not_stable_path",
    command,
    config,
    expected,
    server: name,
    status: stable ? "stable" : "unstable",
  };
}

/**
 * The channel server's own report, or unknown when it wrote none or the file cannot be read. A
 * report naming a conversation other than the role's binding is `status_file_stale`. Never
 * clearance.
 */
function channelServer(layout: Layout, role: string, binding: string | null): ChannelServer {
  const resolution = channelResolution(layout, role, binding);
  if (resolution.state === "missing" || resolution.state === "unreadable") {
    return {
      argv: null,
      code: resolution.state === "missing" ? "status_file_missing" : "status_file_unreadable",
      conversation: null,
      distSha256: null,
      pid: null,
      startedAt: null,
      status: "unknown",
      version: null,
    };
  }
  const { status } = resolution;
  return {
    argv: status.argv,
    code: resolution.state === "current" ? "status_file_read" : "status_file_stale",
    conversation: status.conversation,
    distSha256: status.distSha256,
    pid: status.pid,
    startedAt: status.startedAt,
    status: "reported",
    version: status.version,
  };
}

interface HarnessDiagnosis {
  readonly schema: 1;
  readonly roles: readonly RoleDiagnosis[];
}

function layer(status: DiagnosticStatus, code: string): LayerDiagnostic {
  return { code, status };
}

function initial(layout: Layout, registry: Registry, role: string): RoleDiagnosis {
  const harness = resolveHarness(registry, role);
  const id = resolveConversation(registry, role);
  return {
    activation: "unknown",
    channel_command: harness === "claude" ? channelCommand(layout) : null,
    channel_reference:
      harness === "claude" ? { path: wakeFilePath(layout, role), source: "wake_file" } : null,
    channel_server: harness === "claude" ? channelServer(layout, role, id) : null,
    config_reference: { path: layout.registryFile, source: "registry" },
    effective_harness: harness,
    endpoint: { path: null, source: "skipped" },
    failed_layer: null,
    layers: {
      adapter: layer("unknown", "scope_not_active"),
      bridge: layer("unknown", "not_probed"),
      channel: layer("unknown", "not_probed"),
      frontend: layer("unknown", "not_probed"),
      service: layer("unknown", "not_probed"),
    },
    native_hold: "unknown",
    native_id: id,
    native_session: layer("unknown", "not_probed"),
    recovery_owner: null,
    role,
    supported_next_action: "none",
  };
}

function failure(
  row: RoleDiagnosis,
  failed: DiagnosticLayer,
  code: string,
  owner: RoleDiagnosis["recovery_owner"],
  action: RoleDiagnosis["supported_next_action"],
): RoleDiagnosis {
  return {
    ...row,
    failed_layer: failed,
    layers: { ...row.layers, [failed]: layer("unavailable", code) },
    recovery_owner: owner,
    supported_next_action: action,
  };
}

async function codex(env: NodeJS.ProcessEnv, row: RoleDiagnosis): Promise<RoleDiagnosis> {
  let endpoint: RoleDiagnosis["endpoint"];
  try {
    endpoint = resolveCodexControlSocket({ env });
  } catch {
    return failure(
      {
        ...row,
        endpoint: {
          path: null,
          source: Object.hasOwn(env, "CODEX_CONTROL_SOCKET") ? "environment" : "managed",
        },
      },
      "adapter",
      "invalid_endpoint_configuration",
      "delivery-kit",
      "verify_endpoint_configuration",
    );
  }
  const selected: RoleDiagnosis = {
    ...row,
    endpoint,
    layers: {
      ...row.layers,
      adapter: layer("available", "endpoint_resolved"),
      bridge: layer("unknown", "native_bridge_probe_unsupported"),
      channel: layer("unknown", "channel_probe_unsupported"),
    },
    recovery_owner: "native-codex",
    supported_next_action: "native_owner_required",
  };
  let client: RpcClient;
  try {
    client = await connectControl(performance.now() + 5000, endpoint.path!);
  } catch {
    return failure(
      selected,
      "service",
      "control_unavailable",
      "native-codex",
      "inspect_native_session",
    );
  }
  const connected = {
    ...selected,
    layers: { ...selected.layers, service: layer("available", "control_initialized") },
  };
  try {
    const result = await client.call("thread/read", {
      includeTurns: false,
      threadId: row.native_id,
    });
    const thread = isRecord(result) && isRecord(result.thread) ? result.thread : null;
    if (thread === null || thread.id !== row.native_id) {
      return failure(
        connected,
        "frontend",
        "native_identity_unverified",
        "native-codex",
        "inspect_native_session",
      );
    }
    const status = isRecord(thread.status) ? thread.status.type : undefined;
    return {
      ...connected,
      layers: {
        ...connected.layers,
        frontend: layer("unknown", "frontend_probe_unsupported"),
      },
      native_session:
        status === "active" || status === "idle"
          ? layer("available", "exact_thread_observed")
          : layer("unknown", "native_state_unknown"),
    };
  } catch {
    return failure(
      connected,
      "frontend",
      "thread_read_unavailable",
      "native-codex",
      "inspect_native_session",
    );
  } finally {
    client.close();
  }
}

function claude(env: NodeJS.ProcessEnv, row: RoleDiagnosis): RoleDiagnosis {
  const entries = listingOrNull(env);
  const selected: RoleDiagnosis = {
    ...row,
    endpoint: { path: null, source: "agents_listing" },
    layers: {
      ...row.layers,
      adapter: layer("available", "agents_listing_supported"),
      bridge: layer("unknown", "native_bridge_probe_unsupported"),
      channel: layer("unknown", "channel_connection_unverified"),
      service: layer(
        entries === null ? "unavailable" : "available",
        entries === null ? "agents_listing_unavailable" : "agents_listing_observed",
      ),
    },
    recovery_owner: "native-claude",
    supported_next_action: "native_owner_required",
  };
  if (entries === null) {
    return failure(
      selected,
      "service",
      "agents_listing_unavailable",
      "native-claude",
      "inspect_native_session",
    );
  }
  const matches = entries.filter((entry) => entry.sessionId === row.native_id);
  if (matches.length === 0) {
    return failure(
      selected,
      "frontend",
      "exact_session_missing",
      "native-claude",
      "inspect_native_session",
    );
  }
  const availability = recipientAvailability(entries, row.native_id!);
  return {
    ...selected,
    layers: {
      ...selected.layers,
      frontend:
        availability.status === null
          ? layer("unknown", "session_reported_state_unknown")
          : layer("available", "exact_session_reported"),
    },
    native_session:
      availability.status === null
        ? layer("unknown", "session_reported_state_unknown")
        : layer("available", "exact_session_reported"),
  };
}

/** Resolve the entire scope before any probe. Unselected harnesses are never contacted. */
export async function diagnoseHarness(
  env: NodeJS.ProcessEnv,
  layout: Layout,
  registry: Registry,
  scope: RoleSelection,
): Promise<HarnessDiagnosis> {
  const roles = resolveSelectedRoles(layout, registry, scope);
  const rows: RoleDiagnosis[] = [];
  for (const role of roles) {
    const row = initial(layout, registry, role);
    const record = registry.roles[role]!;
    if (
      record.ownership !== "active" ||
      record.phase === "held" ||
      record.phase === "source-held"
    ) {
      rows.push(row);
    } else if (row.native_id === null) {
      rows.push(
        failure(row, "adapter", "native_id_missing", "delivery-kit", "inspect_native_session"),
      );
    } else {
      // Serial bounded probes avoid opening a connection for every selected role at once.
      // eslint-disable-next-line no-await-in-loop
      rows.push(row.effective_harness === "codex" ? await codex(env, row) : claude(env, row));
    }
  }
  return { roles: rows, schema: 1 };
}
