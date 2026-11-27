import { randomUUID } from "node:crypto";

import { cliApi, number, object, pages, runForge } from "../../adapters/forge/api.ts";
import type { Clock } from "../../core/clock.ts";
import type { GitHubTaskStoreConfig } from "../../core/configuration/standalone.ts";
import { isObject } from "../../core/validate.ts";
import { Store } from "../../store/db.ts";
import {
  PROJECT_TASK_KINDS,
  type ProjectTask,
  readProjectTask,
} from "../../store/projects/tasks.ts";
import { type Actor, ensure, ROLE, type StoredEvent, StoreError } from "../../store/types.ts";

type IssueApi = (
  endpoint: string,
  method?: "GET" | "POST" | "PATCH",
  body?: Readonly<Record<string, unknown>>,
) => unknown;

interface Issue {
  readonly comments: number;
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed";
}

export interface IssueLink {
  readonly number: number;
  readonly url: string;
}

interface Batch {
  readonly project: string;
  readonly nonce: string;
  readonly parent: number;
  readonly events: readonly StoredEvent[];
}

interface Transaction {
  readonly id: number;
  readonly body: string;
}

interface Journal {
  readonly head: number;
  readonly events: readonly StoredEvent[];
  readonly receipts: Map<string, Transaction>;
  readonly tasks: Map<string, number>;
}

type TaskActor = Actor & { readonly role: string; readonly nativeId: string };

const JOURNAL_MARKER = "<!-- coordination-kit:tasks:v1\n";
const STATUS_MARKER = "<!-- coordination-kit:task-status:v1 ";
const COMMENT_END = "\n-->";
const MAX_COMMENT_LENGTH = 60_000;
const UUID = /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/i;
const PRIVATE_PATH = /\bfile:\/|(?:^|[\s:(])\/(?:home|Users|tmp|run|var|root)\//;
const TASK_ID = /^issue-([1-9][0-9]*)$/;

const githubApi = cliApi("gh", "github.com", runForge);
const request: IssueApi = (path, method, body) => {
  if (method !== "PATCH") {
    return githubApi(path, method, body);
  }
  return JSON.parse(
    runForge(
      "gh",
      ["api", "--hostname", "github.com", "--method", method, path, "--input", "-"],
      JSON.stringify(body),
    ),
  ) as unknown;
};

function taskIssueNumber(id: string): number {
  const value = Number(TASK_ID.exec(id)?.[1]);
  ensure(Number.isSafeInteger(value) && value > 0, "project-github-issue-id-required");
  return value;
}

function publicValue(value: unknown): void {
  if (typeof value === "string") {
    ensure(!UUID.test(value) && !PRIVATE_PATH.test(value), "project-github-private-task-data");
  } else if (Array.isArray(value)) {
    value.forEach(publicValue);
  } else if (isObject(value)) {
    Object.values(value).forEach(publicValue);
  }
}

function batchBody(batch: Batch): string {
  const body = `${JOURNAL_MARKER}${Buffer.from(JSON.stringify(batch)).toString("base64")}${COMMENT_END}`;
  ensure(body.length <= MAX_COMMENT_LENGTH, "project-github-batch-too-large");
  return body;
}

function decodeBatch(body: string): Record<string, unknown> {
  try {
    ensure(body.endsWith(COMMENT_END), "project-github-journal-invalid");
    const encoded = body.slice(JOURNAL_MARKER.length, -COMMENT_END.length);
    const bytes = Buffer.from(encoded, "base64");
    ensure(bytes.toString("base64") === encoded, "project-github-journal-invalid");
    return object(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new StoreError("project-github-journal-invalid");
  }
}

function checkEvent(value: unknown, author: number, control: number): value is StoredEvent {
  if (!isObject(value) || !isObject(value.actor) || !isObject(value.payload)) {
    return false;
  }
  const { actor, payload } = value;
  return (
    typeof value.kind === "string" &&
    PROJECT_TASK_KINDS.has(value.kind) &&
    typeof actor.role === "string" &&
    ROLE.test(actor.role) &&
    actor.nativeId === `github-account:${author}` &&
    actor.worker === undefined &&
    typeof payload.id === "string" &&
    taskIssueNumber(payload.id) !== control &&
    typeof payload.owner === "string" &&
    ROLE.test(payload.owner)
  );
}

function display(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export class GitHubTasks {
  readonly #base: string;
  readonly #url: string;
  readonly #project: string;
  readonly #settings: GitHubTaskStoreConfig;
  readonly #api: IssueApi;

  constructor(
    repository: string,
    project: string,
    settings: GitHubTaskStoreConfig,
    api: IssueApi = request,
  ) {
    this.#base = `repos/${repository}`;
    this.#url = `https://github.com/${repository}`;
    this.#project = project;
    this.#settings = settings;
    this.#api = api;
  }

  #issuePath(id: number): string {
    return `${this.#base}/issues/${id}`;
  }

  #issueUrl(id: number): string {
    return `${this.#url}/issues/${id}`;
  }

  #issue(id: number): Issue {
    const issue = object(this.#api(this.#issuePath(id)));
    const url = this.#issueUrl(id);
    ensure(
      issue.number === id &&
        typeof issue.comments === "number" &&
        Number.isSafeInteger(issue.comments) &&
        issue.comments >= 0 &&
        issue.pull_request === undefined &&
        typeof issue.html_url === "string" &&
        issue.html_url.toLowerCase() === url.toLowerCase() &&
        (issue.state === "open" || issue.state === "closed"),
      "project-github-issue-unverified",
    );
    return { comments: issue.comments, number: id, state: issue.state, url };
  }

  link(id: string): IssueLink {
    const issue = taskIssueNumber(id);
    ensure(issue !== this.#settings.issue, "project-github-control-issue-reserved");
    return { number: issue, url: this.#issueUrl(issue) };
  }

  verifyIssue(id: string): Issue {
    return this.#issue(this.link(id).number);
  }

  #comments(issue: number): Record<string, unknown>[] {
    return pages((endpoint) => this.#api(endpoint), `${this.#issuePath(issue)}/comments`, {});
  }

  #trustedAuthor(comment: Record<string, unknown>): number | undefined {
    const author = isObject(comment.user) ? comment.user.id : undefined;
    return typeof author === "number" && this.#settings.writers.includes(author)
      ? author
      : undefined;
  }

  #readJournal(): Journal {
    const control = this.#settings.issue;
    const before = this.#issue(control);
    ensure(before.state === "open", "project-github-control-issue-closed");
    const rows = this.#comments(control);
    const after = this.#issue(control);
    ensure(
      after.state === "open" && before.comments === rows.length && after.comments === rows.length,
      "project-github-journal-incomplete",
    );
    const receipts = new Map<string, Transaction>();
    const tasks = new Map<string, number>();
    const committed = new Set([0]);
    const events: StoredEvent[] = [];
    let head = 0;
    let priorId = 0;
    for (const comment of rows) {
      const id = number(comment.id);
      ensure(id > priorId, "project-github-comment-order-unverified");
      priorId = id;
      const body = comment.body;
      const author = this.#trustedAuthor(comment);
      if (author === undefined || typeof body !== "string" || !body.startsWith(JOURNAL_MARKER)) {
        continue;
      }
      const { events: batch, nonce, parent, project } = decodeBatch(body);
      ensure(
        project === this.#project &&
          typeof nonce === "string" &&
          UUID.test(nonce) &&
          typeof parent === "number" &&
          committed.has(parent) &&
          Array.isArray(batch) &&
          batch.length > 0 &&
          batch.every((event) => checkEvent(event, author, control)),
        "project-github-journal-invalid",
      );
      if (parent !== head) {
        continue;
      }
      ensure(!receipts.has(nonce), "project-github-journal-invalid");
      head = id;
      committed.add(id);
      events.push(...(batch as StoredEvent[]));
      receipts.set(nonce, { body, id });
      for (const event of batch as StoredEvent[]) {
        tasks.set(event.payload.id as string, id);
      }
    }
    return { events, head, receipts, tasks };
  }

  read<T>(clock: Clock, read: (store: Store) => T): T {
    const store = Store.fromEvents(clock, this.#readJournal().events);
    try {
      return read(store);
    } finally {
      store.close();
    }
  }

  async mutate<T>(
    clock: Clock,
    actor: TaskActor,
    id: string,
    action: (store: Store, actor: TaskActor) => T | Promise<T>,
  ): Promise<T> {
    const writer = number(object(this.#api("user")).id);
    ensure(this.#settings.writers.includes(writer), "project-github-writer-required");
    const issue = this.verifyIssue(id);
    const previous = this.#readJournal();
    const store = Store.fromEvents(clock, previous.events);
    try {
      const before = store.head().seq;
      const result = await action(store, { ...actor, nativeId: `github-account:${writer}` });
      const events = store.events({ afterSeq: before });
      if (events.length > 0) {
        for (const event of events) {
          ensure(
            checkEvent(event, writer, this.#settings.issue) && event.payload.id === id,
            "project-github-event-invalid",
          );
          publicValue(event.payload);
        }
        ensure(
          issue.state === "open" || events[0]?.kind !== "project-task.proposed",
          "project-github-issue-closed",
        );
        this.#commit(previous.head, events);
      }
      const current = this.#readJournal();
      const receipt = current.tasks.get(id);
      ensure(receipt !== undefined, "project-github-task-receipt-missing");
      const projection = Store.fromEvents(clock, current.events);
      try {
        const record = readProjectTask(projection.index, id);
        ensure(record !== null, "project-task-missing");
        this.#syncIssue(issue, record, receipt);
      } finally {
        projection.close();
      }
      return result;
    } finally {
      store.close();
    }
  }

  #commit(parent: number, events: readonly StoredEvent[]): void {
    const nonce = randomUUID();
    const body = batchBody({ events, nonce, parent, project: this.#project });
    const endpoint = `${this.#issuePath(this.#settings.issue)}/comments`;
    let acknowledged = false;
    try {
      this.#api(endpoint, "POST", { body });
      acknowledged = true;
    } catch {
      // Transport failure can occur after the provider has persisted this exact batch.
    }
    const receipt = this.#readJournal().receipts.get(nonce);
    ensure(
      receipt?.body === body,
      acknowledged ? "project-github-write-conflict" : "project-github-write-unverified",
    );
  }

  #syncIssue(issue: Issue, task: ProjectTask, receipt: number): void {
    const marker = `${STATUS_MARKER}${this.#project} ${task.id} ${receipt} -->`;
    const body = [
      marker,
      `**Coordination Kit task:** ${task.id} · **State:** ${task.state}`,
      "",
      `**Title:** ${display(task.title)}`,
      `**Owner:** ${task.owner}`,
      `${task.approval === null ? "**Proposed scope:**" : "**Approved scope:**"} ${display(task.scope)}`,
      ...(task.dependsOn.length === 0
        ? []
        : [
            `**Dependencies:** ${task.dependsOn
              .map((id) => `#${this.link(id).number}`)
              .join(", ")}`,
          ]),
      ...(task.reviewRequest === null ? [] : [`**Review:** ${task.reviewRequest.url}`]),
      "",
      `[Journal entry ${receipt}](${this.#issueUrl(this.#settings.issue)}#issuecomment-${receipt})`,
    ].join("\n");
    const visible = () =>
      this.#comments(issue.number).some(
        (comment) => comment.body === body && this.#trustedAuthor(comment) !== undefined,
      );
    if (!visible()) {
      try {
        this.#api(`${this.#issuePath(issue.number)}/comments`, "POST", { body });
      } catch {
        // A lost response can still leave the expected visible status.
      }
      ensure(visible(), "project-github-issue-status-unverified");
    }
    if (
      (task.state === "landed" || task.state === "declined" || task.state === "cancelled") &&
      this.#issue(issue.number).state !== "closed"
    ) {
      try {
        this.#api(this.#issuePath(issue.number), "PATCH", {
          state: "closed",
          state_reason: task.state === "landed" ? "completed" : "not_planned",
        });
      } catch {
        // Closing is idempotent and could have succeeded before the response was lost.
      }
      ensure(this.#issue(issue.number).state === "closed", "project-github-issue-close-unverified");
    }
  }
}
