/**
 * Thin, typed access to the native macOS shell. Messages go to
 * `window.webkit.messageHandlers.liteverse`; native replies arrive through
 * `window.__liteverse*` receiver functions registered by `useLiteverse`.
 * During development `desktop/dev-bridge.ts` installs a fictional in-memory
 * stand-in with the same contract.
 */

export type NativeMessage = { action: string } & Record<string, unknown>;

type MessageHandler = { postMessage: (payload: unknown) => void };

type HostWindow = Window & {
  webkit?: { messageHandlers?: { liteverse?: MessageHandler } };
};

export function nativeBridge(): MessageHandler | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as HostWindow).webkit?.messageHandlers?.liteverse;
}

export function hasNativeBridge() {
  return Boolean(nativeBridge());
}

/** Posts a message; returns false when no native shell is attached. */
export function post(action: string, payload: Record<string, unknown> = {}) {
  const bridge = nativeBridge();
  if (!bridge) return false;
  bridge.postMessage({ action, ...payload });
  return true;
}

export type Receivers = Record<string, ((...args: never[]) => void) | undefined>;

/** Installs receiver callbacks on window and returns a cleanup function. */
export function installReceivers(receivers: Receivers) {
  const host = window as unknown as Record<string, unknown>;
  for (const [name, callback] of Object.entries(receivers)) host[name] = callback;
  return () => {
    for (const name of Object.keys(receivers)) delete host[name];
  };
}

export function requestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
