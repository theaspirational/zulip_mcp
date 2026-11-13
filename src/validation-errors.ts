/** Fixed caller-facing validation wording only; never response bodies or user text. */
export class CallerValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'CallerValidationError'; }
}
export class StreamPolicyError extends Error {
  constructor(reason?: 'revoked snapshot' | 'unknown state' | 'address changed' | 'attachment not in message') {
    super(`Read refused by subscribed-stream policy${reason ? `: ${reason}` : ''}`);
    this.name = 'StreamPolicyError';
  }
}
