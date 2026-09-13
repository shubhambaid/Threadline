import { randomUUID } from "node:crypto";
import { refreshCache, sessions, users } from "./store.js";

export function signIn(userId) {
  const token = randomUUID();
  const session = { userId, tokenVersion: users.get(userId).tokenVersion };
  sessions.set(token, session);
  refreshCache.set(token, session);
  return token;
}

/** Like production, refresh reads the cache before the sessions table. */
export function refresh(token) {
  const session = refreshCache.get(token) ?? sessions.get(token);
  if (!session) return { status: 401 };
  // A cached session is only as good as its version: a password reset bumps the user's version.
  if (session.tokenVersion !== users.get(session.userId).tokenVersion) return { status: 401 };
  return { status: 200, session };
}
