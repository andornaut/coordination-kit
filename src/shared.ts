// @andornaut/coordination-kit/build/shared: the kit utilities both kits run on. Durable files,
// flock(1) locks, the game-coordinator layout, validation, a game's delivery-kit.json, the command
// contract and help synopses, identifiers and the Python-compatible JSON form of persisted state.
export {
  type CodexControlSocketEndpoint,
  type CodexControlSocketOptions,
  resolveCodexControlSocket,
} from "./adapters/shared/endpoints.ts";
export * from "./core/config.ts";
export * from "./core/durable.ts";
export * from "./core/ids.ts";
export * from "./core/io.ts";
export * from "./core/layout.ts";
export * from "./core/lock.ts";
export * from "./core/pyjson.ts";
export * from "./core/usage.ts";
export * from "./core/validate.ts";
