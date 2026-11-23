/**
 * An action's answer as a test compares it: all of it but the revision,
 * which the tests of revisions read on their own.
 */
export const answer = <T>(result: T): T => {
  if (result === null || typeof result !== "object" || !("revision" in result)) {
    return result;
  }
  const { revision: _revision, ...rest } = result as Record<string, unknown>;
  return rest as T;
};
