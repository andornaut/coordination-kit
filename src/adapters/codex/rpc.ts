// JSON-RPC over a WebSocket on the local Codex control socket, using only node: builtins.
//
// It connects to ws://localhost/ over the Unix socket, sends
// `initialize` and the `initialized` notification, then matches responses by request id. Server
// notifications and server-initiated requests belong to the existing client and are skipped.
import { randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { performance } from "node:perf_hooks";

import { isRecord } from "../../core/encoding/pyjson.ts";
import { type DeliveryDiagnostic, safeDeliveryDiagnostic, safeRpcCode } from "../types.ts";
import { acceptKey, decodeFrames, encodeFrame, MessageAssembler, OPCODE } from "./websocket.ts";

/** Each socket wait is bounded as well as the whole exchange. */
const STEP_MS = 5000;

export class RpcError extends Error {
  readonly code: ReturnType<typeof safeRpcCode>;
  readonly diagnostic: DeliveryDiagnostic;
  readonly staleTurn: boolean;

  constructor(error: unknown, method?: string) {
    super("native request rejected");
    this.name = "RpcError";
    const record = isRecord(error) ? error : {};
    this.code = safeRpcCode(record.code);
    const message = typeof record.message === "string" ? record.message : "";
    this.staleTurn = /expectedTurnId.*(?:does not match|mismatch)/i.test(message);
    const category = this.staleTurn
      ? "stale-turn"
      : /direct(?: app[- ]?server)? input (?:is )?not allowed/i.test(message)
        ? "direct-input-not-allowed"
        : "rpc-refusal";
    this.diagnostic = safeDeliveryDiagnostic({
      category,
      classification: "native-rejected",
      method,
      rpcCode: this.code,
      stage:
        method === "initialize"
          ? "connection"
          : method?.startsWith("thread/") && method !== "thread/queue/add"
            ? "question-guard"
            : "native-send",
    })!;
  }
}

export class NativeTimeout extends Error {
  constructor(what: string) {
    super(`native ${what} deadline`);
    this.name = "NativeTimeout";
  }
}

export interface RpcClient {
  /** Exact release parsed from the app-server initialize user agent, when available. */
  readonly serverVersion?: string;
  /** Send one request within the client deadline or an earlier request deadline. */
  call(method: string, params: unknown, deadline?: number): Promise<unknown>;
  close(): void;
}

interface Handshake {
  readonly key: string;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

class Connection implements RpcClient {
  serverVersion?: string;
  private readonly socket: Socket;
  private readonly deadline: number;
  private readonly assembler: MessageAssembler;
  private readonly messages: string[] = [];
  private buffer: Buffer = Buffer.alloc(0);
  private open = false;
  private failure: Error | undefined;
  private wake: (() => void) | undefined;
  private sequence = 0;
  private handshake: Handshake | undefined;

  constructor(deadline: number, socket: Socket) {
    this.deadline = deadline;
    this.socket = socket;
    this.assembler = new MessageAssembler((opcode, payload) => this.sendFrame(opcode, payload));
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("native connection closed")));
  }

  upgrade(): Promise<void> {
    const key = randomBytes(16).toString("base64");
    return new Promise((resolve, reject) => {
      this.handshake = { key, reject, resolve };
      this.socket.write(
        [
          "GET / HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      if (!this.open) {
        this.finishHandshake();
      }
      if (this.open) {
        const { frames, rest } = decodeFrames(this.buffer);
        this.buffer = rest;
        const messages = this.assembler.accept(frames);
        if (messages === null) {
          this.fail(new Error("native connection closed"));
          return;
        }
        this.messages.push(...messages);
        this.notify();
      }
    } catch (error) {
      this.fail(error as Error);
    }
  }

  private finishHandshake(): void {
    const end = this.buffer.indexOf("\r\n\r\n");
    if (end < 0 || this.handshake === undefined) {
      return;
    }
    const { key, reject, resolve } = this.handshake;
    this.handshake = undefined;
    const head = this.buffer.subarray(0, end).toString("latin1");
    const [status = "", ...headers] = head.split("\r\n");
    this.buffer = Buffer.from(this.buffer.subarray(end + 4));
    const accept = headers
      .map((line) => line.split(/:\s*/, 2))
      .find(([name]) => name?.toLowerCase() === "sec-websocket-accept")?.[1];
    if (!/^HTTP\/1\.1 101\b/.test(status) || accept !== acceptKey(key)) {
      reject(new Error("native upgrade refused"));
      return;
    }
    this.open = true;
    resolve();
  }

  private fail(error: Error): void {
    const failure = this.failure ?? error;
    this.failure = failure;
    if (this.handshake !== undefined) {
      this.handshake.reject(failure);
      this.handshake = undefined;
    }
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    this.socket.write(encodeFrame(true, opcode, payload));
  }

  private remaining(what: string, deadline = this.deadline): number {
    const remaining = Math.min(this.deadline, deadline) - performance.now();
    if (remaining <= 0) {
      throw new NativeTimeout(what);
    }
    return Math.min(STEP_MS, remaining);
  }

  send(message: unknown): void {
    this.remaining("request");
    if (this.failure !== undefined) {
      throw this.failure;
    }
    this.sendFrame(OPCODE.text, Buffer.from(JSON.stringify(message), "utf8"));
  }

  private async next(deadline?: number): Promise<string> {
    const waitMs = this.remaining("response", deadline);
    const queued = this.messages.shift();
    if (queued !== undefined) {
      return queued;
    }
    if (this.failure !== undefined) {
      throw this.failure;
    }
    let timer: NodeJS.Timeout | undefined;
    const woken = await new Promise<boolean>((resolve) => {
      this.wake = () => resolve(true);
      timer = setTimeout(() => resolve(false), waitMs);
    });
    clearTimeout(timer);
    this.wake = undefined;
    if (!woken) {
      throw new NativeTimeout("response");
    }
    return this.next(deadline);
  }

  async call(method: string, params: unknown, deadline?: number): Promise<unknown> {
    this.remaining("request", deadline);
    this.sequence += 1;
    const id = this.sequence;
    this.send({ id, method, params });
    for (;;) {
      // Responses arrive one at a time on one connection.
      // eslint-disable-next-line no-await-in-loop
      const message = JSON.parse(await this.next(deadline)) as unknown;
      if (typeof message !== "object" || message === null) {
        continue;
      }
      const record = message as Record<string, unknown>;
      if (record.id !== id || "method" in record) {
        continue;
      }
      if ("error" in record) {
        throw new RpcError(record.error, method);
      }
      return record.result;
    }
  }

  close(): void {
    this.socket.destroy();
  }
}

/** Connect, upgrade and initialize within `deadline` (a performance.now() value). */
export async function connectControl(deadline: number, socketPath: string): Promise<RpcClient> {
  const socket = createConnection({ path: socketPath });
  const connection = new Connection(deadline, socket);
  try {
    const timeout = Math.max(0, Math.min(STEP_MS, deadline - performance.now()));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      connection.upgrade(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new NativeTimeout("connect")), timeout);
      }),
    ]).finally(() => clearTimeout(timer));
    const initialized = await connection.call("initialize", {
      capabilities: { experimentalApi: true },
      clientInfo: { name: "hourly-unblock", version: "1" },
    });
    if (isRecord(initialized) && typeof initialized.userAgent === "string") {
      const version = /^[^/()\r\n]{1,80}\/(\d+\.\d+\.\d+) \(/.exec(initialized.userAgent)?.[1];
      if (version !== undefined) {
        connection.serverVersion = version;
      }
    }
    connection.send({ method: "initialized" });
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
}
