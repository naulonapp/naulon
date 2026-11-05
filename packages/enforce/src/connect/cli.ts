/**
 * `naulon connect`: connect a site you run, from a terminal beside it.
 *
 *   naulon connect --site https://blog.example.com [--gate https://gate.example.com] [--dir .naulon]
 *
 * Run it where the app runs, in the app's directory. The app must already serve naulon with
 * `naulonSite({ connect: { clientName } })`: the gate checks the site itself before the owner can
 * approve, and the app is what answers. This command only starts the connect, prints the address to
 * approve at (open it on any device, a phone works over SSH), and waits. The app finishes the
 * return, keeps the credential in the shared directory and starts tolling; this reports the result.
 */
import { naulonConnect } from "./connect.ts";
import { fileConnectStore, naulonDir, type ConnectResult } from "./local.ts";

const HELP = `naulon connect: connect a site you run to its gate

usage: naulon connect --site <https://your-site> [--gate <url>] [--dir <path>] [--timeout <minutes>]

  --site     the site's own address, as readers reach it (or NAULON_SITE)
  --gate     the gate to connect to (or NAULON_GATE; default https://gate.naulon.app)
  --dir      the directory the app shares with this command (or NAULON_DIR; default .naulon)
  --timeout  how long to wait for the approval, in minutes (default 15)

Run it beside the app, which must serve naulon with naulonSite({ connect: { clientName } }).`;

export interface ConnectMainIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultIo: ConnectMainIo = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  env: process.env,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
};

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

export async function connectMain(args: string[], io: ConnectMainIo = defaultIo): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(HELP);
    return 0;
  }
  const site = flag(args, "site") ?? io.env.NAULON_SITE;
  if (!site) {
    io.err("naulon connect: --site is required, e.g. --site https://blog.example.com\n");
    io.err(HELP);
    return 2;
  }
  const gate = flag(args, "gate") ?? io.env.NAULON_GATE;
  const dir = flag(args, "dir") ?? naulonDir({ ...(io.env.NAULON_DIR ? { NAULON_DIR: io.env.NAULON_DIR } : {}) });
  const minutes = Number(flag(args, "timeout") ?? 15);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    io.err("naulon connect: --timeout must be a number of minutes");
    return 2;
  }

  const store = fileConnectStore(dir, io.now);
  // The name the owner reads comes from the app's own client document, which the gate fetches from
  // the site; this one is never shown.
  const connect = naulonConnect({ clientName: "naulon connect", ...(gate ? { gate } : {}), store, now: io.now });
  const started = await connect.start({ site });
  if (!started.ok) {
    io.err(`naulon connect: ${started.error}`);
    return 1;
  }
  const state = new URL(started.url).searchParams.get("state") ?? "";
  io.out("Open this address to approve, on any device:\n");
  io.out(`  ${started.url}\n`);
  io.out(`Waiting for the approval (up to ${minutes} min). The app finishes the connect; leave it running.`);

  const deadline = io.now() + minutes * 60_000;
  let result: ConnectResult | null = null;
  while (!result && io.now() < deadline) {
    await io.sleep(1_000);
    result = await store.takeResult(state);
  }
  if (!result) {
    io.err("naulon connect: no approval arrived in time. Run it again when you are ready to approve.");
    return 1;
  }
  if (!result.ok) {
    io.err(`naulon connect: ${result.message}`);
    return 1;
  }
  io.out(`\nConnected: ${new URL(result.site).host} tolls through ${new URL(result.gate).host}.`);
  io.out(`The app keeps the credential in ${dir}/credential and uses it now, with no restart.`);
  io.out("To pin it instead, set NAULON_KEY to that value in the app's environment.");
  return 0;
}
