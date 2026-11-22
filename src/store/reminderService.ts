import { performance } from "node:perf_hooks";

import { clearanceUnchanged, nativeItems, questionItem } from "../adapters/codex/guard.ts";
import { connectControl, type RpcClient } from "../adapters/codex/rpc.ts";
import { selectTarget } from "../adapters/codex/steer.ts";
import { decisionDirectory } from "../adapters/shared/decisions.ts";
import { resolveCodexControlSocket } from "../adapters/shared/endpoints.ts";
import { isRecord } from "../adapters/shared/pyjson.ts";
import { type CallerOptions, resolveCaller } from "./identity.ts";
import { noticeQueueClear } from "./noticeEvidence.ts";
import { noticeText } from "./noticesInFlight.ts";
import {
  checkReminder,
  claimReminder,
  listReminders,
  pendingReminders,
  reminderClearance,
  type ReminderOutcome,
  type ReminderReceipt,
  requireReminderCoordinator,
  settleReminder,
} from "./reminders.ts";
import { registry, type StoreServiceContext, withStore } from "./service.ts";
import { StoreError } from "./types.ts";

function coordinator(context: StoreServiceContext, caller: CallerOptions) {
  const roles = registry(context);
  const actor = resolveCaller(roles, context.env, caller);
  requireReminderCoordinator(roles, actor);
  return { actor, scope: { layout: context.layout, registry: roles } };
}

export async function storeReminderList(context: StoreServiceContext) {
  return withStore(
    context,
    (store) => ({
      candidates: listReminders(store, { layout: context.layout, registry: registry(context) }),
      inFlight: pendingReminders(store),
      schema: 2 as const,
    }),
    { createMissing: false },
  );
}

export async function storeReminderClaim(
  context: StoreServiceContext,
  caller: CallerOptions,
  selection: { readonly role: string; readonly originals: readonly string[] },
) {
  coordinator(context, caller);
  return withStore(context, (store) =>
    store.transaction(() => {
      const { actor, scope } = coordinator(context, caller);
      const receipt = claimReminder(store, scope, actor, selection);
      return {
        notice: noticeText(receipt.originals.length, receipt.role, receipt.id),
        receipt,
        schema: 1 as const,
      };
    }),
  );
}

type CheckContext = StoreServiceContext & { readonly connectReminder?: () => Promise<RpcClient> };

const QUALIFIED_IDLE_VERSION = "0.171.0";

async function requireIdleRoot(client: RpcClient, recipient: string): Promise<void> {
  const read = await client.call("thread/read", { includeTurns: false, threadId: recipient });
  const thread = isRecord(read) && isRecord(read.thread) ? read.thread : null;
  if (
    thread === null ||
    thread.id !== recipient ||
    thread.parentThreadId != null ||
    (thread.source !== "cli" && thread.source !== "vscode") ||
    thread.canAcceptDirectInput !== true ||
    !isRecord(thread.status) ||
    thread.status.type !== "idle" ||
    (thread.status.activeFlags !== undefined &&
      (!Array.isArray(thread.status.activeFlags) || thread.status.activeFlags.length > 0))
  ) {
    throw new StoreError("reminder-native-guarded");
  }
}

async function completedHead(client: RpcClient, recipient: string): Promise<string> {
  const response = await client.call("thread/turns/list", {
    itemsView: "notLoaded",
    limit: 1,
    sortDirection: "desc",
    threadId: recipient,
  });
  const rows = isRecord(response) && Array.isArray(response.data) ? response.data : [];
  const head: unknown = rows[0];
  if (
    rows.length !== 1 ||
    !isRecord(head) ||
    head.status !== "completed" ||
    typeof head.id !== "string" ||
    head.id === "" ||
    (head.threadId !== undefined && head.threadId !== recipient)
  ) {
    throw new StoreError("reminder-native-clearance-unverified");
  }
  return head.id;
}

/** In the qualified server, pending blocking requests make a loaded thread active. */
async function qualifyIdle(client: RpcClient, recipient: string): Promise<void> {
  if (client.serverVersion !== QUALIFIED_IDLE_VERSION) {
    throw new StoreError("reminder-native-clearance-unverified");
  }
  try {
    const head = await completedHead(client, recipient);
    const items = await nativeItems(client, recipient, head);
    if (
      [...items.values()].some(questionItem) ||
      head !== (await completedHead(client, recipient))
    ) {
      throw new StoreError("reminder-native-clearance-unverified");
    }
  } catch {
    throw new StoreError("reminder-native-clearance-unverified");
  }
}

async function nativeIdle(context: CheckContext, receipt: ReminderReceipt): Promise<void> {
  const directory = decisionDirectory(context.layout, receipt.role);
  if (directory === null) {
    throw new StoreError("reminder-owner-clearance-required");
  }
  const marker = reminderClearance(directory, receipt.nativeId);
  if (marker === undefined) {
    throw new StoreError("reminder-owner-clearance-required");
  }
  let client: RpcClient;
  try {
    client = await (context.connectReminder?.() ??
      connectControl(
        performance.now() + 3000,
        resolveCodexControlSocket({ env: context.env }).path,
      ));
  } catch {
    throw new StoreError("reminder-native-unavailable");
  }
  try {
    await requireIdleRoot(client, receipt.nativeId);
    if (marker === null) {
      await qualifyIdle(client, receipt.nativeId);
    } else {
      const [target, , diagnostic] = await selectTarget(client, directory, receipt.nativeId);
      if (diagnostic?.category === "compaction-unproven") {
        await qualifyIdle(client, receipt.nativeId);
      } else if (
        diagnostic?.category === "history-unavailable" ||
        diagnostic?.category === "question-resolution"
      ) {
        throw new StoreError("reminder-native-clearance-unverified");
      } else if (target?.method !== "turn/start") {
        throw new StoreError("reminder-native-guarded");
      }
    }
    if (!(await noticeQueueClear(client, { conversation: receipt.nativeId, role: receipt.role }))) {
      throw new StoreError("reminder-native-queue-unverified");
    }
    await requireIdleRoot(client, receipt.nativeId);
    const unchanged =
      marker === null
        ? reminderClearance(directory, receipt.nativeId) === null
        : clearanceUnchanged(directory, receipt.nativeId, marker);
    if (!unchanged) {
      throw new StoreError("reminder-owner-clearance-required");
    }
  } catch (error) {
    if (error instanceof StoreError) {
      throw error;
    }
    throw new StoreError("reminder-native-unavailable");
  } finally {
    client.close();
  }
}

/** Read the exact recipient state, then recheck all persisted and registry guards. */
export async function storeReminderCheck(context: CheckContext, caller: CallerOptions, id: string) {
  const current = () =>
    withStore(
      context,
      (store) => {
        const { actor, scope } = coordinator(context, caller);
        return checkReminder(store, scope, actor, id);
      },
      { createMissing: false },
    );
  const receipt = await current();
  await nativeIdle(context, receipt);
  return { nativeIdle: true as const, receipt: await current(), schema: 1 as const };
}

export async function storeReminderSettle(
  context: StoreServiceContext,
  caller: CallerOptions,
  settlement: { readonly id: string; readonly outcome: ReminderOutcome; readonly reason: string },
) {
  coordinator(context, caller);
  return withStore(context, (store) =>
    store.transaction(() => {
      const { actor, scope } = coordinator(context, caller);
      return {
        schema: 1 as const,
        settlement: settleReminder(store, scope, actor, settlement),
      };
    }),
  );
}
