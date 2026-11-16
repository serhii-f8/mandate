/** Trivial activity of the Phase 1 smoke workflow. */
export function echo(message: string): Promise<string> {
  return Promise.resolve(message);
}
