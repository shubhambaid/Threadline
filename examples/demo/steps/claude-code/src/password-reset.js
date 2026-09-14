import { users } from "./store.js";

export function resetPassword(userId) {
  const user = users.get(userId);
  user.passwordChangedAt = Date.now();
  // Every session issued earlier now carries an older version and is rejected on refresh.
  user.tokenVersion += 1;
}
