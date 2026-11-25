// What the command handlers share: the caller options, reading parsed values, and turning an
// error into its printed message or refusal code.
import type { CallerOptions } from "../store/identity.ts";
import { StoreError } from "../store/types.ts";

/** The options every store writer takes to name its caller. */
export const CALLER = {
  "native-id": { type: "string" },
  worker: { type: "string" },
} as const;

export type Values = Record<string, string | boolean | string[] | undefined>;

/** A usage error: the handler prints its usage refusal and exits 2. */
export class Usage extends Error {}

export function text(values: Values, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

export function required(values: Values, key: string): string {
  const value = text(values, key);
  if (value === undefined) {
    throw new Usage();
  }
  return value;
}

export function callerOf(values: Values): CallerOptions {
  const nativeId = text(values, "native-id");
  const worker = text(values, "worker");
  return {
    ...(nativeId === undefined ? {} : { nativeId }),
    ...(worker === undefined ? {} : { worker }),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A store refusal's code when it is a plain token, else `fallback`. */
export function refusalCode(error: unknown, fallback: string): string {
  return error instanceof StoreError && /^[a-z][a-z-]{0,63}$/.test(error.code)
    ? error.code
    : fallback;
}
