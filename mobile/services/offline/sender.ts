/**
 * Sender indirection.
 *
 * The outbox sync runner needs to make authenticated requests, but the auth /
 * token logic lives in api.ts — and api.ts imports the offline layer to wrap
 * its endpoints. To avoid a circular import, api.ts registers its authenticated
 * request function here at module load, and the sync runner reads it back.
 */
export type Sender = (
  path: string,
  method: string,
  body: unknown,
) => Promise<any>;

let _send: Sender | null = null;

export function setSender(send: Sender): void {
  _send = send;
}

export function getSender(): Sender {
  if (!_send) throw new Error("offline sender not initialized");
  return _send;
}
