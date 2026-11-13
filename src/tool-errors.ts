import { ZulipNoAnswer, ZulipRefused } from './zulip-api.js';
import { SendRefused } from './outgoing.js';

import { CallerValidationError, StreamPolicyError } from './validation-errors.js';
export { CallerValidationError, StreamPolicyError } from './validation-errors.js';

const CODES = new Set(['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'RATE_LIMIT_HIT', 'INTERNAL_SERVER_ERROR',
  'REQUEST_VARIABLE_MISSING', 'REQUEST_VARIABLE_INVALID', 'INVALID_API_KEY', 'INVALID_MESSAGE_ID',
  'STREAM_DOES_NOT_EXIST', 'BAD_EVENT_QUEUE_ID', 'REQUEST_TIMEOUT', 'UNSUPPORTED_OPERATION',
  'USER_NOT_AUTHORIZED', 'MESSAGE_NOT_FOUND', 'INSUFFICIENT_PERMISSION']);

/** No action, URL, stream identity, topic, content, or arbitrary remote wording. */
export function subscribedError(error: unknown, policyText = 'Operation refused by subscribed-stream policy'): string {
  if (error instanceof StreamPolicyError) return policyText;
  if (error instanceof CallerValidationError) return `Error: ${error.message}`;
  let nested = error;
  for (let depth = 0; depth < 4 && nested instanceof Error && nested.cause !== undefined && nested.cause !== nested; depth++) {
    nested = nested.cause;
    if (nested instanceof ZulipNoAnswer || nested instanceof ZulipRefused || nested instanceof SendRefused) return subscribedError(nested, policyText);
  }
  if (error instanceof ZulipRefused || error instanceof SendRefused) {
    const code = error instanceof SendRefused ? error.answer.code : error.code;
    const status = error.status;
    return `Error: Zulip error (${typeof code === 'string' && CODES.has(code) ? code : 'UNKNOWN'}${typeof status === 'number' && status >= 100 && status <= 599 ? `; HTTP ${status}` : ''})`;
  }
  if (error instanceof ZulipNoAnswer) return `Error: ${error.kind === 'timeout' ? 'timeout' : error.kind === 'network' ? 'network' : 'internal'} error`;
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return 'Error: timeout error';
  return 'Error: internal error';
}
