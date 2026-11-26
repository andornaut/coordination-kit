import { spawnSync } from "node:child_process";

import { ForgeError, type ForgeRunner } from "./types.ts";

export type Api = (
  endpoint: string,
  method?: "GET" | "POST" | "PUT",
  body?: Readonly<Record<string, unknown>>,
) => unknown;

/** Stderr and failed stdout may contain credentials from a provider's debug mode. */
export const runForge: ForgeRunner = (command, args, input) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
    timeout: 30_000,
  });
  if (result.error !== undefined && "code" in result.error && result.error.code === "ENOENT") {
    throw new ForgeError("forge-cli-unavailable");
  }
  if (result.error !== undefined || result.status !== 0) {
    throw new ForgeError("forge-request-failed");
  }
  return result.stdout;
};

export function cliApi(command: "gh" | "glab", hostname: string, run: ForgeRunner): Api {
  return (endpoint, method = "GET", body) => {
    const args = ["api", "--hostname", hostname, "--method", method, endpoint];
    let output;
    try {
      if (body !== undefined) {
        args.push("--input", "-");
      }
      output = run(command, args, body === undefined ? undefined : JSON.stringify(body));
    } catch (error) {
      throw error instanceof ForgeError ? error : new ForgeError("forge-request-failed");
    }
    try {
      return JSON.parse(output) as unknown;
    } catch {
      throw new ForgeError("forge-response-invalid");
    }
  };
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ForgeError("forge-response-invalid");
  }
  return value as Record<string, unknown>;
}

export function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new ForgeError("forge-response-invalid");
  }
  return value.map(object);
}

export function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ForgeError("forge-response-invalid");
  }
  return value;
}

export function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function number(value: unknown): number {
  if (!positiveInteger(value)) {
    throw new ForgeError("forge-response-invalid");
  }
  return value;
}

export function isSha(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

export function sha(value: unknown): string {
  if (!isSha(value)) {
    throw new ForgeError("forge-response-invalid");
  }
  return value;
}

export function reviewUrl(hostname: string, value: unknown): string {
  const link = URL.parse(text(value));
  if (
    link === null ||
    link.protocol !== "https:" ||
    link.host !== hostname ||
    link.username !== "" ||
    link.password !== "" ||
    link.search !== "" ||
    link.hash !== ""
  ) {
    throw new ForgeError("forge-response-invalid");
  }
  return link.href;
}

export function pages(
  api: Api,
  endpoint: string,
  query: Readonly<Record<string, string>>,
  select: (payload: unknown) => unknown = (payload) => payload,
): Record<string, unknown>[] {
  const perPage = 100;
  const result: Record<string, unknown>[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const params = new URLSearchParams({ ...query, page: String(page), per_page: String(perPage) });
    const batch = rows(select(api(`${endpoint}?${params}`)));
    result.push(...batch);
    if (batch.length < perPage) {
      return result;
    }
  }
  throw new ForgeError("forge-response-invalid");
}
