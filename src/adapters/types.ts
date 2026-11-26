// Safe delivery diagnostics are finite metadata, never native messages or context.
const DIAGNOSTIC_METHODS = [
  "initialize",
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
  "thread/queue/add",
  "turn/start",
  "turn/steer",
] as const;
const STAGES = ["local", "connection", "question-guard", "native-send", "receipt"] as const;
const CATEGORIES = [
  "owner-unavailable",
  "decision-clearance",
  "input-unavailable",
  "pending-question",
  "question-resolution",
  "history-unavailable",
  "compaction-unproven",
  "state-unavailable",
  "rpc-refusal",
  "direct-input-not-allowed",
  "stale-turn",
  "transport-unavailable",
  "busy",
  "binding-mismatch",
  "deduplicated",
  "unchanged",
  "unknown",
] as const;
const CLASSIFICATIONS = ["guarded", "native-rejected", "outcome-unknown", "unavailable"] as const;
const RPC_CODES = [-32700, -32600, -32601, -32602, -32603, -32000] as const;
type NativeRpcCode = (typeof RPC_CODES)[number];
type NativeQuestionRef = {
  readonly turnId: string;
  readonly itemId: string;
};
export type DeliveryDiagnostic = {
  readonly stage: (typeof STAGES)[number];
  readonly category: (typeof CATEGORIES)[number];
  readonly classification: (typeof CLASSIFICATIONS)[number];
  readonly method?: (typeof DIAGNOSTIC_METHODS)[number];
  readonly rpcCode?: NativeRpcCode;
  readonly question?: NativeQuestionRef;
};
const SAFE_NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function safeNativeQuestionRef(value: unknown): NativeQuestionRef | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { itemId, turnId } = value as Record<string, unknown>;
  return typeof turnId === "string" &&
    typeof itemId === "string" &&
    SAFE_NATIVE_ID.test(turnId) &&
    SAFE_NATIVE_ID.test(itemId)
    ? { itemId, turnId }
    : undefined;
}

export function safeRpcCode(value: unknown): NativeRpcCode | undefined {
  return RPC_CODES.includes(value as NativeRpcCode) ? (value as NativeRpcCode) : undefined;
}
/** Project only explicitly allowed fields; unknown native codes and methods are omitted. */
export function safeDeliveryDiagnostic(value: unknown): DeliveryDiagnostic | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    !STAGES.includes(record.stage as DeliveryDiagnostic["stage"]) ||
    !CATEGORIES.includes(record.category as DeliveryDiagnostic["category"]) ||
    !CLASSIFICATIONS.includes(record.classification as DeliveryDiagnostic["classification"])
  ) {
    return undefined;
  }
  const method = DIAGNOSTIC_METHODS.includes(
    record.method as NonNullable<DeliveryDiagnostic["method"]>,
  )
    ? (record.method as NonNullable<DeliveryDiagnostic["method"]>)
    : undefined;
  const rpcCode = safeRpcCode(record.rpcCode);
  const question =
    record.category === "pending-question" && record.stage === "question-guard"
      ? safeNativeQuestionRef(record.question)
      : undefined;
  return {
    category: record.category as DeliveryDiagnostic["category"],
    classification: record.classification as DeliveryDiagnostic["classification"],
    stage: record.stage as DeliveryDiagnostic["stage"],
    ...(method === undefined ? {} : { method }),
    ...(question === undefined ? {} : { question }),
    ...(rpcCode === undefined ? {} : { rpcCode }),
  };
}

// What the review asks the native collectors for and what they return.
type CollectorRecord = Readonly<Record<string, unknown>>;

/** What a snapshot asks the harness collectors for. */
export interface CollectRequest {
  /** Validated local decision markers keyed by the exact native recipient. */
  readonly decisionRecords: Readonly<Record<string, CollectorRecord | null>>;
  readonly recipients: readonly string[];
  readonly parents: readonly string[];
  readonly slot: number | null;
  /** Resume ordering after this child ID, keyed by the same current native parent. */
  readonly workerCursors?: Readonly<Record<string, string>>;
}

/** Snapshot capabilities, keyed by the snapshot record field names. */
export interface Collected {
  readonly history: CollectorRecord;
  readonly question_state: CollectorRecord;
  readonly worker_health: CollectorRecord;
  readonly collection_budget: CollectorRecord;
}
