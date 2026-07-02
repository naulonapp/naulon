/**
 * Dev stack runner — boots the tollgate and the dashboard together with prefixed,
 * colorized output, and tears both down cleanly on Ctrl-C. No extra deps.
 *
 *   node scripts/dev.mjs        (or: make dev)
 */
import { spawn } from "node:child_process";

const services = [
  // Stub origin first — the publisher stand-in the tollgate proxies once paid.
  // Real deployments drop this and point ORIGIN_URL at the live site.
  { name: "origin", color: "\x1b[35m", cmd: ["node", "scripts/origin.mjs"] },
  { name: "tollgate", color: "\x1b[33m", pkg: "@naulon/tollgate" },
  { name: "dashboard", color: "\x1b[36m", pkg: "@naulon/dashboard" },
];
const RESET = "\x1b[0m";
const children = [];

function prefix(name, color, line) {
  return `${color}${name.padEnd(9)}|${RESET} ${line}`;
}

for (const svc of services) {
  const [cmd, ...rest] = svc.cmd ?? ["npm", "run", "start", "-w", svc.pkg];
  const child = spawn(cmd, rest, { env: process.env });
  children.push(child);
  const pipe = (stream) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) process.stdout.write(prefix(svc.name, svc.color, l) + "\n");
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => {
    process.stdout.write(prefix(svc.name, svc.color, `exited (${code})`) + "\n");
  });
}

function shutdown() {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("naulon dev stack — origin :3000 · tollgate :8402 · dashboard :8403 (Ctrl-C to stop)\n");
