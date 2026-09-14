import { users } from "./store.js";

export function resetPassword(userId) {
  const user = users.get(userId);
  user.passwordChangedAt = Date.now();
  // Sessions issued before the reset should stop working. Not implemented yet.
}
