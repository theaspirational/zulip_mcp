/** Optional additions never change the upstream default surface. */
export function pollsEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return env.ZULIP_POLLS === '1'; }
export function movesEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return env.ZULIP_MOVE_MESSAGES === '1'; }
export function toolEnabled(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (['send_poll', 'get_poll_results', 'vote_poll'].includes(name)) return pollsEnabled(env);
  return name !== 'move_messages' || movesEnabled(env);
}
