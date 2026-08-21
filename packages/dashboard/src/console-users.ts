/**
 * Operator accounts: create, authenticate, change, disable.
 *
 * The point of having accounts at all is that "who ran that test toll" has an answer.
 * One shared credential cannot answer it however well it is hashed, which is why this
 * exists on top of credential.ts rather than instead of it.
 *
 * Deliberately NOT here: self-signup. Grafana defaults `allow_sign_up` to false and a
 * private ops console has no signup story whatsoever — accounts are made by an admin, or
 * by the first-run bootstrap, and by nothing else.
 */
import { randomUUID } from "node:crypto";
import { hashPassword, verifySecret } from "./credential.ts";
import type { ConsoleRole, ConsoleStore, ConsoleUser } from "./console-store.ts";

/**
 * Twelve characters. The console shows payout wallets and takes writes, and — until the
 * session cookie replaces it for browsers — the credential is sent on every request.
 * NIST-style length-over-composition: no character-class rules, which push people to
 * `Password1!` and add no entropy worth the friction.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** Usernames are compared case-insensitively; `Ops` and `ops` are one account, not two. */
export const normalizeUsername = (raw: string): string => raw.trim().toLowerCase();

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export interface CreateUserInput {
  username: string;
  password: string;
  role: ConsoleRole;
  /** Seeded accounts must change their password before the console renders anything else. */
  mustChangePassword?: boolean;
  now?: () => Date;
}

export type CreateUserResult = { ok: true; user: ConsoleUser } | { ok: false; error: string };

export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

export function validateUsername(username: string): string | null {
  const name = normalizeUsername(username);
  if (!USERNAME_RE.test(name)) {
    return "Username must be 2-32 characters: letters, digits, dot, dash or underscore, starting with a letter or digit.";
  }
  return null;
}

export async function createUser(store: ConsoleStore, input: CreateUserInput): Promise<CreateUserResult> {
  const nameError = validateUsername(input.username);
  if (nameError) return { ok: false, error: nameError };
  const passwordError = validatePassword(input.password);
  if (passwordError) return { ok: false, error: passwordError };

  const username = normalizeUsername(input.username);
  // Hash BEFORE taking the lock: it is ~350 ms and holding the store's write lock for it
  // would serialise every other session touch behind an account creation.
  const passwordHash = await hashPassword(input.password);
  const stamp = (input.now?.() ?? new Date()).toISOString();

  return store.update((draft) => {
    if (draft.users.some((u) => normalizeUsername(u.username) === username)) {
      return { ok: false as const, error: "That username is taken." };
    }
    const user: ConsoleUser = {
      id: randomUUID(),
      username,
      passwordHash,
      role: input.role,
      createdAt: stamp,
      passwordChangedAt: stamp,
      ...(input.mustChangePassword ? { mustChangePassword: true } : {}),
    };
    draft.users.push(user);
    return { ok: true as const, user };
  });
}

/**
 * A hash to verify against when the username does not exist.
 *
 * Without it, a wrong username returns in microseconds while a wrong password takes
 * ~350 ms, and that difference is a working account-enumeration oracle over the network.
 * Minted once, lazily, from a value nobody knows — its only job is to cost the same as a
 * real verification.
 */
let decoyHash: Promise<string> | null = null;
const decoy = (): Promise<string> => (decoyHash ??= hashPassword(randomUUID() + randomUUID()));

export interface AuthenticateResult {
  user: ConsoleUser | null;
  /** Distinguishes "no such account / wrong password" from "the account is switched off". */
  disabled: boolean;
}

export async function authenticate(
  store: ConsoleStore,
  username: string,
  password: string,
): Promise<AuthenticateResult> {
  const name = normalizeUsername(username);
  const state = await store.read();
  const user = state.users.find((u) => normalizeUsername(u.username) === name);

  if (!user) {
    await verifySecret(await decoy(), password);
    return { user: null, disabled: false };
  }
  const ok = await verifySecret(user.passwordHash, password);
  if (!ok) return { user: null, disabled: false };
  // Checked AFTER the password, so a disabled account cannot be used to probe passwords
  // any faster than a live one, and so the audit line records a real credential match.
  if (user.disabledAt) return { user: null, disabled: true };
  return { user, disabled: false };
}

export async function setPassword(
  store: ConsoleStore,
  userId: string,
  password: string,
  now: () => Date = () => new Date(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const error = validatePassword(password);
  if (error) return { ok: false, error };
  const passwordHash = await hashPassword(password);
  const stamp = now().toISOString();
  return store.update((draft) => {
    const user = draft.users.find((u) => u.id === userId);
    if (!user) return { ok: false as const, error: "No such account." };
    user.passwordHash = passwordHash;
    user.passwordChangedAt = stamp;
    delete user.mustChangePassword;
    return { ok: true as const };
  });
}

export function setDisabled(
  store: ConsoleStore,
  userId: string,
  disabled: boolean,
  now: () => Date = () => new Date(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  return store.update((draft) => {
    const user = draft.users.find((u) => u.id === userId);
    if (!user) return { ok: false as const, error: "No such account." };
    if (disabled) {
      // The last live admin may not switch themselves off: the console would then have no
      // way back in short of editing the state file by hand, which is the kind of dead end
      // a self-hoster reports as data loss.
      const liveAdmins = draft.users.filter((u) => u.role === "admin" && !u.disabledAt);
      if (user.role === "admin" && liveAdmins.length <= 1) {
        return { ok: false as const, error: "This is the only administrator left." };
      }
      user.disabledAt = now().toISOString();
      // Their live sessions go with them — disabling an account that stays signed in for
      // another eight hours is not disabling it.
      draft.sessions = draft.sessions.filter((s) => s.userId !== userId);
    } else {
      delete user.disabledAt;
    }
    return { ok: true as const };
  });
}

export async function listUsers(store: ConsoleStore): Promise<ConsoleUser[]> {
  const state = await store.read();
  return [...state.users].sort((a, b) => a.username.localeCompare(b.username));
}

export async function hasAnyUser(store: ConsoleStore): Promise<boolean> {
  return (await store.read()).users.length > 0;
}
