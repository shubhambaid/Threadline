/** A problem with how Alethic was invoked or where it is running. Maps to exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}
