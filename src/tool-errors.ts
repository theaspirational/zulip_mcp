import { ZulipNoAnswer, ZulipRefused } from './zulip-api.js';
import { SendRefused } from './outgoing.js';

import { CallerValidationError, StreamPolicyError } from './validation-errors.js';
export { CallerValidationError, StreamPolicyError } from './validation-errors.js';

const CODES = new Set(['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'RATE_LIMIT_HIT', 'INTERNAL_SERVER_ERROR',
  'REQUEST_VARIABLE_MISSING', 'REQUEST_VARIABLE_INVALID', 'INVALID_API_KEY', 'INVALID_MESSAGE_ID',
  'STREAM_DOES_NOT_EXIST', 'BAD_EVENT_QUEUE_ID', 'REQUEST_TIMEOUT', 'UNSUPPORTED_OPERATION',
  'USER_NOT_AUTHORIZED', 'MESSAGE_NOT_FOUND', 'INSUFFICIENT_PERMISSION']);

/** Recognize typed causes through preparation/runtime wrappers, without trusting remote text.
 * Cycles and excessive wrapper graphs are bounded; policy refusals take precedence. */
function wrappedErrors(error: unknown): unknown[] {
  const found: unknown[] = [];
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length && seen.size < 64) {
    const value = pending.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    found.push(value);
    for (const key of ['cause', 'error', 'originalError', 'innerError'] as const) {
      const nested = (value as Record<string, unknown>)[key];
      if (nested !== undefined) pending.push(nested);
    }
  }
  return found;
}

/** No action, URL, stream identity, topic, content, or arbitrary remote wording. */
export function subscribedError(error: unknown, policyText = 'Operation refused by subscribed-stream policy'): string {
  const errors = wrappedErrors(error);
  if (errors.some(e => e instanceof StreamPolicyError)) return policyText;
  const validation = errors.find(e => e instanceof CallerValidationError);
  if (validation instanceof CallerValidationError) return `Error: ${validation.message}`;
  for (const nested of errors) {
    if (nested instanceof ZulipRefused || nested instanceof SendRefused) {
      const code = nested instanceof SendRefused ? nested.answer.code : nested.code;
      const status = nested.status;
      return `Error: Zulip error (${typeof code === 'string' && CODES.has(code) ? code : 'UNKNOWN'}${typeof status === 'number' && status >= 100 && status <= 599 ? `; HTTP ${status}` : ''})`;
    }
    if (nested instanceof ZulipNoAnswer) return `Error: ${nested.kind === 'timeout' ? 'timeout' : nested.kind === 'network' ? 'network' : 'internal'} error`;
    if (nested instanceof Error && ['TimeoutError', 'AbortError'].includes(nested.name)) return 'Error: timeout error';
  }
  return 'Error: internal error';
}
