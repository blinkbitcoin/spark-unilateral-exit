// Extract a human-readable message from an unknown thrown value. Shared so the
// several catch sites that surface an error's text render it the same way.
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
