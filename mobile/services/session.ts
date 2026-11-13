/** Immutable identity for async work. A token refresh is not an account switch. */
export type SessionContext = Readonly<{ ownerId: string | null; generation: number }>;
export type AccountContext = SessionContext & { readonly ownerId: string };

let current: SessionContext = Object.freeze({ ownerId: null, generation: 0 });
const listeners = new Set<() => void>();

export class SessionChangedError extends Error {
  constructor() {
    super("The signed-in account changed. Please try again.");
    this.name = "SessionChangedError";
  }
}

export function captureSession(): SessionContext {
  return current;
}

export function isCurrentSession(session: SessionContext): boolean {
  return session === current;
}

export function assertSession(session: SessionContext): void {
  if (!isCurrentSession(session)) throw new SessionChangedError();
}

export function requireAccount(session = captureSession()): AccountContext {
  assertSession(session);
  if (!session.ownerId) throw new SessionChangedError();
  return session as AccountContext;
}

export function replaceSession(ownerId: string | null = null): SessionContext {
  const next = Object.freeze({ ownerId, generation: current.generation + 1 });
  current = next;
  for (const listener of listeners) listener();
  return next;
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
