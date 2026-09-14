import { sessions, users } from "./store.js";

export function resetPassword(userId) {
  const user = users.get(userId);
  user.passwordChangedAt = Date.now();
  for (const [token, session] of sessions) {
    if (session.userId === userId) sessions.delete(token);
  }
}
