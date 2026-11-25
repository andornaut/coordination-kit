// Channel server: a stdio MCP server started by the recipient Claude session itself. It answers
// the MCP handshake and, after `notifications/initialized`, emits one notification per increase of
// the conversation's wake file seq. A wake carries no payload: the recipient pulls its messages.
import { initializeResult, wakeNotification } from "./protocol.ts";
import { wakeText, type WakeWatcher } from "./wakeFile.ts";

/** Writes one complete line synchronously; throws when the channel output is unusable. */
export type LineWriter = (line: string) => void;

type Json = Record<string, unknown>;

interface Message {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

/** Answer requests; returns true once the client reports initialization. */
export function handle(write: LineWriter, message: Message): boolean {
  if (!Object.hasOwn(message, "id")) {
    return message.method === "notifications/initialized";
  }
  const { id, method, params } = message;
  let reply: Json;
  if (method === "initialize") {
    reply = { id, jsonrpc: "2.0", result: initializeResult(params) };
  } else if (method === "ping") {
    reply = { id, jsonrpc: "2.0", result: {} };
  } else {
    reply = { error: { code: -32601, message: "method not found" }, id, jsonrpc: "2.0" };
  }
  write(`${JSON.stringify(reply)}\n`);
  return false;
}

interface ServeOptions {
  readonly pollMs: number;
  /** Polled after every message and every poll; each seq increase emits one notification. */
  readonly wake?: WakeWatcher;
}

/**
 * Serve until input ends (exit 0) or the output fails (exit 1). Wakes are emitted only after
 * `notifications/initialized`, then after every message and every poll.
 */
export function serve(
  options: ServeOptions,
  input: NodeJS.ReadableStream,
  write: LineWriter,
): Promise<number> {
  return new Promise((resolve) => {
    let initialized = false;
    let buffer = "";
    let running = false;
    let finished = false;
    const finish = (code: number): void => {
      if (!finished) {
        finished = true;
        clearInterval(timer);
        input.removeAllListeners("data");
        // Release stdin so the process can exit once the consumer stops.
        input.pause();
        (input as { destroy?: () => void }).destroy?.();
        resolve(code);
      }
    };
    const drain = (): void => {
      if (!initialized || running || finished) {
        return;
      }
      running = true;
      try {
        const wake = options.wake?.poll();
        if (wake !== undefined) {
          try {
            write(`${JSON.stringify(wakeNotification(wakeText(wake), wake.seq))}\n`);
          } catch {
            finish(1);
          }
        }
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => drain(), options.pollMs);
    input.setEncoding?.("utf8");
    input.on("data", (chunk: string | Buffer) => {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof message === "object" && message !== null && !Array.isArray(message)) {
          try {
            initialized = handle(write, message as Message) || initialized;
          } catch {
            finish(1);
            return;
          }
        }
      }
      drain();
    });
    input.once("end", () => finish(0));
    input.once("error", () => finish(1));
  });
}
