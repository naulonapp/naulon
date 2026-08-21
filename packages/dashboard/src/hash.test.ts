import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHashArgs } from "./hash.ts";

test("a bare positional password is the password — it used to be dropped", () => {
  // The regression: with no `--user`, indexOf returned -1 and the filter excluded argv[0],
  // so `npm run hash -- <password>` read an empty stdin and refused a 22-character
  // password as "at least 12 characters".
  assert.deepEqual(parseHashArgs(["argument-password-2026"]), {
    username: undefined,
    password: "argument-password-2026",
  });
});

test("--user takes the value after it, and does not eat the password", () => {
  assert.deepEqual(parseHashArgs(["--user", "ops", "argument-password-2026"]), {
    username: "ops",
    password: "argument-password-2026",
  });
  // ...in either order.
  assert.deepEqual(parseHashArgs(["argument-password-2026", "--user", "ops"]), {
    username: "ops",
    password: "argument-password-2026",
  });
});

test("no arguments means prompt or pipe, not an empty password", () => {
  assert.deepEqual(parseHashArgs([]), { username: undefined, password: undefined });
  // `--user` alone still leaves the password unset rather than borrowing the username.
  assert.deepEqual(parseHashArgs(["--user", "ops"]), { username: "ops", password: undefined });
});
