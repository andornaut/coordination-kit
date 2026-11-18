// Step scheduled review slots one wall-clock minute at a time through the built seam, one observer
// pass per slot. Real-time mode uses the next real minute for collectors that compare slots with
// the real time.
import { execute, impl } from "./adapter.ts";
import { at } from "./time.ts";
import type { Workspace } from "./workspace.ts";

export interface SlotOutput {
  slot: number;
  /** The helper's status JSON, or undefined when the pass reported it unavailable. */
  output: Record<string, unknown> | undefined;
}

export class ReviewSchedule {
  private lines: string[] = [];
  private now: number;

  private readonly realtime: boolean;

  constructor(
    private readonly ws: Workspace,
    options: { start?: number; realtime?: boolean } = {},
  ) {
    this.realtime = options.realtime ?? false;
    this.now = this.realtime ? Math.floor(Date.now() / 1000) : (options.start ?? at(0, 30));
  }

  async start(): Promise<void> {}

  /** Advance one minute and run that slot's scheduled review. */
  async slot(): Promise<SlotOutput> {
    let slot: number;
    if (this.realtime) {
      // The next wall-clock minute after the previous slot, once it has begun.
      slot = this.now - (this.now % 60) + 60;
      this.now = slot;
      const wait = slot * 1000 - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    } else {
      this.now += 60;
      slot = this.now - (this.now % 60);
    }
    const pass = await execute(impl.review(this.ws, slot));
    const lines = pass.stdout.split("\n").filter((line) => line !== "");
    this.lines.push(...lines);
    const prefix = `bus: scheduled review ${slot}`;
    const line = lines.find((row) => row.startsWith(prefix));
    if (line === undefined) {
      throw new Error([`no "${prefix}" line`, pass.stdout, pass.stderr].join("\n"));
    }
    const json = line.slice(prefix.length);
    return {
      slot,
      output: json.startsWith(": ")
        ? (JSON.parse(json.slice(2)) as Record<string, unknown>)
        : undefined,
    };
  }

  output(): string {
    return this.lines.join("\n");
  }

  async stop(): Promise<void> {}
}
