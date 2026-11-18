// Shared command contract: exit codes, process I/O, handler shape and coordinator root lookup.
export const EXIT_OK = 0;
export const EXIT_INVALID = 1;
export const EXIT_USAGE = 2;
/** `run` refused to start because another runner holds runner.lock or loop.lock. */
export const EXIT_REFUSED = 3;

export interface Io {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export type Handler = (io: Io, root: string, args: string[]) => number | Promise<number>;

/**
 * The coordinator root the environment names: a nonempty COORDINATION_KIT_ROOT, else
 * DELIVERY_KIT_ROOT (read as in delivery-kit 4.7.0).
 */
export function coordinatorRoot(env: NodeJS.ProcessEnv): string | undefined {
  return env.COORDINATION_KIT_ROOT || env.DELIVERY_KIT_ROOT;
}
