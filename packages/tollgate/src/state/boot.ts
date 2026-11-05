/**
 * The first thing a gate process does: open its state store and fill in the secrets the environment
 * left unset. It must run before anything reads the config, because the config refuses to parse
 * without a stable licence key once real money or a shared backend is in play, and first boot is
 * what supplies it. The entrypoints therefore import the app only after this resolves.
 */
import { stateLocationOf, stateStoreFor, type GateStateStore } from "@naulon/shared";
import { bootstrapSecrets, describeBootstrap, type BootstrapReport } from "./bootstrap.ts";

let current: GateStateStore | null = null;

/** The store this process booted with. Null in a process that never booted (tests, an embedder). */
export function gateState(): GateStateStore | null {
  return current;
}

export interface Booted {
  store: GateStateStore;
  report: BootstrapReport;
}

export async function bootGateState(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = console.log): Promise<Booted> {
  const loc = stateLocationOf(env);
  const store = stateStoreFor(loc.backend, loc.dir, env);
  const report = await bootstrapSecrets(store, env);
  const where = loc.backend === "file" ? loc.dir : loc.backend === "supabase" ? "the naulon_gate_state table" : "memory (lost on restart)";
  for (const line of describeBootstrap(report, where)) log(line);
  current = store;
  return { store, report };
}
