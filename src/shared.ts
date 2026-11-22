// @andornaut/coordination-kit/build/shared: the kit utilities both kits run on. Durable files,
// flock(1) locks, the game-coordinator layout, validation, a game's delivery-kit.json, the command
// contract and help synopses, identifiers and the Python-compatible JSON form of persisted state.
export {
  type CodexControlSocketEndpoint,
  type CodexControlSocketOptions,
  resolveCodexControlSocket,
} from "./adapters/shared/endpoints.ts";
export * from "./adapters/shared/ids.ts";
export * from "./adapters/shared/pyjson.ts";
export * from "./commands/usage.ts";
export * from "./config.ts";
export * from "./durable.ts";
export * from "./io.ts";
export * from "./layout.ts";
export * from "./lock.ts";
export * from "./validate.ts";
