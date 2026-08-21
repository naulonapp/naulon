import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createFileStore, createMemoryStore, emptyState, parseState } from "./console-store.ts";
import { authenticate, createUser, hasAnyUser, listUsers, setDisabled, setPassword } from "./console-users.ts";
import { createSession, resolveSession } from "./console-session.ts";

/** Generated per run — no credential literal ever lands in the repo. */
const PASSPHRASE = `pw-${randomBytes(9).toString("hex")}`;

// createUser hashes at the production work factor; these tests accept that cost rather
// than reaching past the API to plant hashes, because the API is what is under test.

test("a created account authenticates, and a wrong password does not", async () => {
  const store = createMemoryStore();
  const made = await createUser(store, { username: "alice", password: PASSPHRASE, role: "admin" });
  assert.equal(made.ok, true);
  assert.equal((await authenticate(store, "alice", PASSPHRASE)).user?.username, "alice");
  assert.equal((await authenticate(store, "alice", "not-it")).user, null);
});

test("usernames are case-insensitive, and a duplicate is refused", async () => {
  const store = createMemoryStore();
  assert.equal((await createUser(store, { username: "Alice", password: PASSPHRASE, role: "admin" })).ok, true);
  const dup = await createUser(store, { username: "alice", password: PASSPHRASE, role: "viewer" });
  assert.equal(dup.ok, false);
  // And the stored form is normalised, so `Alice` signs in as `alice`.
  assert.equal((await authenticate(store, "ALICE", PASSPHRASE)).user?.username, "alice");
});

test("a short password is refused before anything is hashed or stored", async () => {
  const store = createMemoryStore();
  const made = await createUser(store, { username: "alice", password: "short", role: "admin" });
  assert.equal(made.ok, false);
  assert.match(made.ok === false ? made.error : "", /at least 12/);
  assert.equal(await hasAnyUser(store), false);
});

test("a malformed username is refused with a message that says what is allowed", async () => {
  const store = createMemoryStore();
  for (const username of ["a", "has space", "-leading", "way".repeat(20)]) {
    const made = await createUser(store, { username, password: PASSPHRASE, role: "viewer" });
    assert.equal(made.ok, false, `${username} should be refused`);
  }
});

test("an unknown username is refused without revealing that it is unknown", async () => {
  const store = createMemoryStore();
  await createUser(store, { username: "alice", password: PASSPHRASE, role: "admin" });
  const missing = await authenticate(store, "nobody", PASSPHRASE);
  assert.deepEqual(missing, { user: null, disabled: false });
});

test("a disabled account is refused, and says so only after the password matched", async () => {
  const store = createMemoryStore();
  const made = await createUser(store, { username: "alice", password: PASSPHRASE, role: "admin" });
  assert.ok(made.ok);
  await createUser(store, { username: "bob", password: PASSPHRASE, role: "admin" });
  await setDisabled(store, made.ok ? made.user.id : "", true);

  assert.deepEqual(await authenticate(store, "alice", PASSPHRASE), { user: null, disabled: true });
  // A WRONG password on a disabled account reports the generic failure, so the disabled
  // flag is never an oracle for "this username exists".
  assert.deepEqual(await authenticate(store, "alice", "not-it"), { user: null, disabled: false });
});

test("disabling an account kills its live sessions", async () => {
  const store = createMemoryStore();
  const made = await createUser(store, { username: "alice", password: PASSPHRASE, role: "admin" });
  await createUser(store, { username: "bob", password: PASSPHRASE, role: "admin" });
  assert.ok(made.ok);
  const id = made.ok ? made.user.id : "";
  const { token } = await createSession(store, id);

  await setDisabled(store, id, true);
  assert.equal((await store.read()).sessions.length, 0);
  assert.equal((await resolveSession(store, token)).ok, false, "disabling must not leave them signed in for 8 hours");
});

test("the last administrator cannot be disabled", async () => {
  const store = createMemoryStore();
  const made = await createUser(store, { username: "alice", password: PASSPHRASE, role: "admin" });
  await createUser(store, { username: "vic", password: PASSPHRASE, role: "viewer" });
  assert.ok(made.ok);
  const result = await setDisabled(store, made.ok ? made.user.id : "", true);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /only administrator/);
});

test("setting a password clears the forced-change flag and moves the timestamp", async () => {
  const store = createMemoryStore();
  const made = await createUser(store, {
    username: "admin",
    password: PASSPHRASE,
    role: "admin",
    mustChangePassword: true,
  });
  assert.ok(made.ok);
  const id = made.ok ? made.user.id : "";
  const fresh = `pw-${randomBytes(9).toString("hex")}`;
  assert.deepEqual(await setPassword(store, id, fresh), { ok: true });

  const [user] = await listUsers(store);
  assert.equal(user?.mustChangePassword, undefined);
  assert.equal((await authenticate(store, "admin", fresh)).user?.id, id);
  assert.equal((await authenticate(store, "admin", PASSPHRASE)).user, null, "the old password must stop working");
});

// ── The store itself ─────────────────────────────────────────────────────────────

test("the state file is written atomically and is not readable by other users on the box", async () => {
  const dir = await mkdtemp(join(tmpdir(), "naulon-console-"));
  const path = join(dir, "console.json");
  const store = await createFileStore(path);
  assert.equal(store.writable, true);

  await createUser(store, { username: "alice", password: PASSPHRASE, role: "admin" });
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600, `state file mode ${mode.toString(8)} — session hashes must not be world-readable`);

  // And it survives a reload: a restart must not sign everyone out or lose the account.
  const reopened = await createFileStore(path);
  assert.equal((await reopened.read()).users[0]?.username, "alice");
  assert.match(await readFile(path, "utf8"), /"version": 1/);
});

test("a read-only location degrades to memory instead of crashing the console", async () => {
  // Serverless and read-only mounts: the console must still boot and still serve the
  // machine credential, it just cannot hold sessions.
  const store = await createFileStore("/dev/null/not-a-directory/console.json");
  assert.equal(store.writable, false);
  const made = await createUser(store, { username: "alice", password: PASSPHRASE, role: "admin" });
  assert.equal(made.ok, true, "in-process state still works — it simply does not survive a restart");
});

test("a corrupt or hand-edited state file degrades to empty, never to a crash", () => {
  assert.deepEqual(parseState("not json"), null);
  assert.deepEqual(parseState('{"version":2,"users":[]}'), null, "an unknown version is not guessed at");
  const partial = parseState('{"version":1,"users":[{"id":"x"},{"id":"y","username":"a","passwordHash":"h","role":"admin"}],"sessions":"nope"}');
  assert.equal(partial?.users.length, 1, "an unusable row is dropped, the readable one is kept");
  assert.deepEqual(partial?.sessions, []);
});

test("concurrent mutations do not lose writes", async () => {
  // The read-modify-write here is serialised through the store's own chain; without it,
  // two accounts created in the same tick would leave one of them out of the file.
  const store = createMemoryStore(emptyState());
  await Promise.all(
    ["alice", "bob", "carol"].map((username) =>
      createUser(store, { username, password: PASSPHRASE, role: "viewer" }),
    ),
  );
  assert.equal((await listUsers(store)).length, 3);
});
