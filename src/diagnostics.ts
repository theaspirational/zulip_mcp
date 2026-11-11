/** stderr is host-visible too. Exceptions and interpolated diagnostics can
 * contain retained stream data with no source ID/epoch. Never serialize them
 * in subscribed mode, even if the destination of the failed operation is OK.
 * Keep the default-mode call (including argument structure) unchanged. */
export function diagnosticError(restricted: boolean, component: string, ...details: unknown[]): void {
  if (restricted) console.error(`[zulip-mcp:${component}] diagnostic details withheld by subscribed-stream policy`);
  else console.error(...details);
}
