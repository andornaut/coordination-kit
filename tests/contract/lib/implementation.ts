// The abstract implementation interface: each CLI operation as a command line.
import type { Workspace } from "./workspace.ts";

export interface Command {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface Implementation {
  readonly name: "node";
  /** True when runnable; otherwise the reason its cases are skipped. */
  readonly available: true | string;
  /** `--help` or `help` without any configuration or state. */
  help(ws: Workspace, word: string): Command;
  /** A command with the game's configuration and state context. */
  command(ws: Workspace, words: string[]): Command;
  /** A command line without configuration or state context. */
  bare(ws: Workspace, words: string[]): Command;
  /** The Claude channel consumer (stdio MCP server). */
  channel(ws: Workspace, args: string[]): Command;
}
