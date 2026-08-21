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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const userIdx = args.indexOf("--user");
  const username = userIdx >= 0 ? args[userIdx + 1] : undefined;
  const positional = args.filter((a, i) => !a.startsWith("--") && i !== userIdx + 1);

  let password: string;
  if (positional.length > 0) {
    password = positional[0] ?? "";
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

await main();
