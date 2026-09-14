// In-memory stand-ins for the users table, the sessions table, and the Redis refresh cache,
// so the demo runs without any services.
export const users = new Map();
export const sessions = new Map();
export const refreshCache = new Map();

export function resetStore() {
  users.clear();
  sessions.clear();
  refreshCache.clear();
  users.set("u1", { id: "u1", tokenVersion: 0 });
}
