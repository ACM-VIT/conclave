/**
 * Where the bring-your-own OpenAI key for the voice agent lives between uses.
 *
 * The key never touches Conclave servers: it is held in this module (tab
 * memory) and, only when the user opts in, mirrored to sessionStorage so a
 * reload within the same tab doesn't re-prompt. sessionStorage is deliberate —
 * it dies with the tab, unlike localStorage, which would keep a live secret
 * on shared machines indefinitely.
 */

const STORAGE_KEY = "conclave.voice-agent.key";

let inMemoryKey: string | null = null;

const readSession = (): string | null => {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable (privacy modes, disabled cookies).
    return null;
  }
};

const writeSession = (value: string | null): void => {
  try {
    if (value === null) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, value);
  } catch {}
};

export function getStoredVoiceAgentKey(): string | null {
  if (inMemoryKey) return inMemoryKey;
  const fromSession = readSession();
  if (fromSession) inMemoryKey = fromSession;
  return fromSession;
}

export function storeVoiceAgentKey(key: string, remember: boolean): void {
  inMemoryKey = key;
  writeSession(remember ? key : null);
}

export function clearStoredVoiceAgentKey(): void {
  inMemoryKey = null;
  writeSession(null);
}
