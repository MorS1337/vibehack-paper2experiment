/** Release policy, not a credential or configuration opt-in. Recovery remains available. */
export const VAST_UNAVAILABLE_REASON = 'Vast — заглушка, платный запуск отключён';

export function assertVastLaunchAllowed(): never {
  throw new Error(VAST_UNAVAILABLE_REASON);
}
