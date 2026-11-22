// Endpoint selection is separate from socket availability, authentication and readiness.
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface CodexControlSocketOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly controlSocket?: string;
}

export interface CodexControlSocketEndpoint {
  readonly path: string;
  readonly source: "option" | "environment" | "managed";
}

const INVALID_PATH = "Codex control socket must be a nonempty absolute path without NUL bytes";

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && !value.includes("\0");
}

function endpoint(
  source: CodexControlSocketEndpoint["source"],
  path: unknown,
): CodexControlSocketEndpoint {
  if (!absolutePath(path)) {
    throw new Error(INVALID_PATH);
  }
  return { path, source };
}

/** Select a path without reading it. Explicit invalid configuration never falls back. */
export function resolveCodexControlSocket(
  options: CodexControlSocketOptions = {},
): CodexControlSocketEndpoint {
  const env = options.env ?? process.env;
  if (options.controlSocket !== undefined) {
    return endpoint("option", options.controlSocket);
  }
  if (Object.hasOwn(env, "CODEX_CONTROL_SOCKET")) {
    return endpoint("environment", env.CODEX_CONTROL_SOCKET);
  }
  const home = options.home ?? homedir();
  if (!absolutePath(home)) {
    throw new Error(INVALID_PATH);
  }
  return endpoint("managed", join(home, ".codex/app-server-control/app-server-control.sock"));
}
