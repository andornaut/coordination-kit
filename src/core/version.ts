// The running CLI's identity: its package version and the sha256 of the dist/cli.js bytes it runs.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { CliIdentity } from "./outcome.ts";

declare const __CK_VERSION__: string;

/** The version a CLI run from source reports; builds replace it with the package version. */
export const SOURCE_VERSION = "0.0.0-source";
export const VERSION = typeof __CK_VERSION__ === "string" ? __CK_VERSION__ : SOURCE_VERSION;
/** The digest a CLI run from source reports, since no dist/cli.js runs: 64 zeros. */
export const SOURCE_DIGEST = "0".repeat(64);

const digests = new Map<string, string>();

/**
 * The identity of the CLI whose entry file is `entry`. A build hashes that file's bytes once per
 * process; from source, or with no entry, the digest is SOURCE_DIGEST.
 */
export function cliIdentity(entry: string | undefined): CliIdentity {
  if (VERSION === SOURCE_VERSION || entry === undefined) {
    return { distSha256: SOURCE_DIGEST, version: VERSION };
  }
  let digest = digests.get(entry);
  if (digest === undefined) {
    digest = createHash("sha256").update(readFileSync(entry)).digest("hex");
    digests.set(entry, digest);
  }
  return { distSha256: digest, version: VERSION };
}
