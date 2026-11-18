// Drive scheduled review slots through the built seam, one observer pass per slot, as
// delivery-kit's runner reaches them. A pass is a fresh process, so stopping and starting again
// is a restart that keeps only durable state.
import { execute, impl } from "./adapter.ts";
import { CodexSocket } from "./codex-socket.ts";
import { at } from "./time.ts";
import { ART, GAMEPLAY, NativeWorld, TECH } from "./unblock-native.ts";
import type { Workspace } from "./workspace.ts";
import { roleRoute } from "./routes.ts";

/** The Codex review route from Tech to Art and Gameplay, hosted by this game. */
export function codexRoute(
  ws: Workspace,
  change: Record<string, unknown> = {},
): Record<string, unknown> {
  return roleRoute(ws, "codex", TECH, [ART, GAMEPLAY], change);
}

function codexRegistry(ws: Workspace): void {
  ws.writeRegistry({
    schema: 1,
    revision: 1,
    harness: "codex",
    roles: {
      "game-coordinator": { conversations: { codex: TECH } },
      art: { conversations: { codex: ART } },
      gameplay: { conversations: { codex: GAMEPLAY } },
    },
  });
}

export function decide(ws: Workspace, recipient: string, record: unknown): void {
  ws.write(
    `unblock/decisions/${recipient}.json`,
    typeof record === "string" ? record : JSON.stringify(record),
  );
}

/** Real UTC now, for owner attestations that the collectors check against wall time. */
export function confirmedAt(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

export interface Tick {
  /** Parsed `bus: scheduled review SLOT: {...}` JSON, when the helper ran. */
  result: Record<string, unknown> | undefined;
  /** Observer output produced for this tick. */
  output: string;
}

export class Reviewed {
  readonly world = new NativeWorld();
  readonly socket: CodexSocket;
  private output = "";

  constructor(readonly ws: Workspace) {
    this.socket = new CodexSocket(ws);
  }

  /** Route-mode setup: registry, route and a clear recipient decision. */
  static async routed(ws: Workspace, route: Record<string, unknown> = {}): Promise<Reviewed> {
    codexRegistry(ws);
    ws.writeRoute(codexRoute(ws, route));
    decide(ws, TECH, { thread_id: TECH, state: "clear" });
    const reviewed = new Reviewed(ws);
    await reviewed.listen();
    return reviewed;
  }

  async listen(): Promise<void> {
    await this.socket.listen();
    this.world.install(this.socket);
    this.ws.env.CODEX_CONTROL_SOCKET = this.socket.path;
  }

  /** Begin a run of slots; the output so far is cleared. */
  async start(): Promise<void> {
    this.output = "";
  }

  async stop(): Promise<void> {}

  async close(): Promise<void> {
    await this.socket.close();
  }

  /** Run the observer pass for `epoch` and return its output; `predicate` must hold for it. */
  async jump(epoch: number, predicate: (output: string) => boolean): Promise<string> {
    const pass = await execute(impl.review(this.ws, epoch));
    const output = pass.stdout + pass.stderr;
    this.output += output;
    if (!predicate(output)) throw new Error(`slot ${epoch} output did not match:\n${output}`);
    return output;
  }

  /** Reach a review slot and return the helper's reported status. */
  async slot(epoch: number): Promise<Tick> {
    const marker = `scheduled review ${epoch}`;
    const output = await this.jump(
      epoch,
      (text) => text.includes(marker) || text.includes("review deferred"),
    );
    const line = output.split("\n").find((row) => row.includes(`${marker}: `));
    const result = line
      ? (JSON.parse(line.slice(line.indexOf(`${marker}: `) + marker.length + 2)) as Record<
          string,
          unknown
        >)
      : undefined;
    return { result, output };
  }

  /** Output written so far in this run. */
  text(): string {
    return this.output;
  }

  receipt(epoch: number, recipient = TECH): Record<string, unknown> {
    return this.ws.readJson(`unblock/${recipient}-${epoch}.json`);
  }

  health(recipient = TECH): Record<string, unknown> {
    return this.ws.readJson(`unblock/health/${recipient}.json`);
  }
}

/** Wake slots: minute 20 and 50 of successive hours. */
export function wake(index: number): number {
  return at(index % 2 === 0 ? 20 : 50, 0, Math.floor(index / 2));
}
