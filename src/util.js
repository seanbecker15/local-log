/** @param {unknown} err @returns {string} the error's message, or the value as text. */
export function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
