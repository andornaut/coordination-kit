// The only Claude Code channel contract dependency: the channel notification and the initialize
// result. It is taken from the installed Claude Code client, not from published
// reference documentation: method notifications/claude/channel with string `content` and
// string-valued `meta` keys matching [A-Za-z_][A-Za-z0-9_]*, the experimental claude/channel
// capability, and a protocol version the client treats as legacy (it skips channel
// registration on a "modern" revision). Re-verify after Claude Code upgrades.
const SERVER_NAME = "delivery-kit-channel";
const LEGACY_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const DEFAULT_PROTOCOL = "2025-06-18";

export interface ChannelNotification {
  readonly jsonrpc: "2.0";
  readonly method: "notifications/claude/channel";
  readonly params: { readonly content: string; readonly meta: Readonly<Record<string, string>> };
}

/** The one notification a wake emits: fixed text, no payload. */
export function wakeNotification(text: string, seq: number): ChannelNotification {
  return {
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: { content: text, meta: { kind: "wake", seq: String(seq) } },
  };
}

export function initializeResult(params: unknown): Record<string, unknown> {
  const requested =
    typeof params === "object" && params !== null
      ? (params as Record<string, unknown>).protocolVersion
      : undefined;
  const protocolVersion = (LEGACY_PROTOCOLS as readonly unknown[]).includes(requested)
    ? (requested as string)
    : DEFAULT_PROTOCOL;
  return {
    capabilities: { experimental: { "claude/channel": {} } },
    instructions:
      "Wakes for stored messages arrive as channel events. " +
      "Run coordination-kit inbox to read them; delivery is not handling.",
    protocolVersion,
    serverInfo: { name: SERVER_NAME, version: "1" },
  };
}
