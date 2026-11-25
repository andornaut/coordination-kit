// The implementation adapter maps abstract CLI operations to command lines for the built CLI.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { Command, Implementation } from "./implementation.ts";
import { nodeImplementation } from "./node-adapter.ts";
import type { Workspace } from "./workspace.ts";

export interface Result {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export const impl: Implementation = nodeImplementation;

export function execute(
  command: Command,
  options: { input?: string; timeoutMs?: number } = {},
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.argv[0]!, command.argv.slice(1), {
      cwd: command.cwd,
      env: command.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    // A command that should exit gets a generous ceiling; only a hung command reaches it.
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      Math.max(options.timeoutMs ?? 0, WAIT_CEILING_MS),
    );
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    // A command may exit before reading its input.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}

/** Run an operation on the selected implementation. */
export function cli(
  ws: Workspace,
  words: string[],
  options?: { input?: string; timeoutMs?: number },
): Promise<Result> {
  return execute(impl.command(ws, words), options);
}

export interface Resident {
  readonly child: ChildProcessWithoutNullStreams;
  readonly done: Promise<Result>;
  /** Poll until the predicate holds; throws with the output on timeout. */
  until(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  /** SIGTERM the process group, then SIGKILL stragglers. */
  stop(): Promise<Result>;
}

/** Start a long-running command (the channel consumer) in its own group. */
export function start(command: Command): Resident {
  const child = spawn(command.argv[0]!, command.argv.slice(1), {
    cwd: command.cwd,
    env: command.env,
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const done = new Promise<Result>((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })),
  );
  let finished = false;
  void done.then(() => (finished = true));
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal);
    } catch {
      // Group already gone.
    }
  };
  return {
    child,
    done,
    async until(predicate, timeoutMs = WAIT_CEILING_MS) {
      const deadline = Date.now() + Math.max(timeoutMs, WAIT_CEILING_MS);
      while (!predicate()) {
        if (finished || Date.now() > deadline) {
          throw new Error(
            `${finished ? "resident exited" : "timed out"} before condition\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    async stop() {
      signalGroup("SIGTERM");
      const timer = setTimeout(() => signalGroup("SIGKILL"), 5_000);
      const result = await done;
      clearTimeout(timer);
      // Never leave a child of the group running after a case.
      signalGroup("SIGKILL");
      return result;
    },
  };
}

/** The least real time any condition wait allows; virtual-time conditions usually end sooner. */
export const WAIT_CEILING_MS = 120_000;
