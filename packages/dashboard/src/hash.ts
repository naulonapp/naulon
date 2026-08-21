/**
 * `npm run hash` — mint the scrypt PHC string that goes in `DASHBOARD_AUTH`.
 *
 * The whole point of hashing the console credential is that the password stops existing
 * anywhere at rest, so this script must not be the thing that writes it somewhere. It
 * reads from a prompt with the echo turned off, or from a pipe; passing the password as
 * an argument is accepted (scripts exist) but says out loud that it just went into the
 * shell history, because a tool that silently undoes its own reason for existing is worse
 * than no tool.
 *
 * Usage:
 *   npm run hash -w @naulon/dashboard                 # prompt, echo off
 *   npm run hash -w @naulon/dashboard -- --user ops   # and print the whole env line
 *   printf %s "$PW" | npm run hash -w @naulon/dashboard
 */
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { hashPassword } from "./credential.ts";

function readPiped(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf.replace(/\r?\n$/, "")));
    process.stdin.on("error", reject);
  });
}

/**
 * Prompt without echoing. `readline`'s own output hook is the supported place to do this;
 * writing the prompt once and swallowing every keystroke after it is what keeps the
 * password off the screen and out of a screen-share.
 */
function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let asked = false;
    // @ts-expect-error — _writeToOutput is readline's documented-by-use echo hook.
    rl._writeToOutput = (chunk: string) => {
      if (!asked) {
        process.stdout.write(chunk);
        asked = true;
      }
    };
    rl.question(question, (answer) => {
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

export interface HashArgs {
  username: string | undefined;
  /** The password, when given on the command line. Undefined means prompt or read a pipe. */
  password: string | undefined;
}

/**
 * Split argv. Extracted so it can be tested, because it silently lost the password:
 * `userIdx + 1` is the index of the username after `--user`, but with no `--user` at all
 * `indexOf` returns -1 and the filter excluded index 0 — the password itself. The command
 * then read an empty stdin and refused a 22-character password as "at least 12
 * characters", naming the wrong cause. Measured 2026-08-21.
 */
export function parseHashArgs(args: readonly string[]): HashArgs {
  const userIdx = args.indexOf("--user");
  const usernameIdx = userIdx >= 0 ? userIdx + 1 : -1;
  const positional = args.filter((a, i) => !a.startsWith("--") && i !== usernameIdx);
  return {
    username: userIdx >= 0 ? args[usernameIdx] : undefined,
    password: positional[0],
  };
}

async function main(): Promise<void> {
  const { username, password: fromArgs } = parseHashArgs(process.argv.slice(2));

  let password: string;
  if (fromArgs !== undefined) {
    password = fromArgs;
    process.stderr.write("warning: the password was passed as an argument — it is in your shell history.\n");
  } else if (!process.stdin.isTTY) {
    password = await readPiped();
  } else {
    password = await prompt("Console password: ");
    const again = await prompt("Again: ");
    if (password !== again) {
      process.stderr.write("They do not match.\n");
      process.exitCode = 1;
      return;
    }
  }

  if (password.length < 12) {
    process.stderr.write(
      "Refusing: the console shows payout wallets and takes writes, and this credential is\n" +
        "sent on every request. Use at least 12 characters.\n",
    );
    process.exitCode = 1;
    return;
  }

  const phc = await hashPassword(password);
  process.stdout.write(username ? `DASHBOARD_AUTH=${username}:${phc}\n` : `${phc}\n`);
}

/**
 * Only when RUN, never when imported. `await main()` at module scope meant that importing
 * anything from this file executed the CLI — a test that imports `parseHashArgs` sat
 * waiting on stdin until it was killed. A module with a side effect at import time cannot
 * be tested, and anything that cannot be tested is where the next bug lives; this one
 * already shipped a defect (see parseHashArgs).
 */
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
