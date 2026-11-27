// @andornaut/coordination-kit/build/shared: the kit utilities both kits run on. Durable files,
// flock(1) locks, the game-coordinator layout, validation, a game's delivery-kit.json, the command
// contract and help synopses, identifiers and the Python-compatible JSON form of persisted state.
export {
  type CodexControlSocketEndpoint,
  type CodexControlSocketOptions,
  resolveCodexControlSocket,
} from "./adapters/shared/endpoints.ts";
export * from "./core/cli/io.ts";
export * from "./core/cli/usage.ts";
export * from "./core/clock.ts";
export * from "./core/configuration/delivery.ts";
export * from "./core/configuration/layout.ts";
export * from "./core/encoding/pyjson.ts";
export * from "./core/files/durable.ts";
export * from "./core/files/lock.ts";
export * from "./core/ids.ts";
export * from "./core/validate.ts";
