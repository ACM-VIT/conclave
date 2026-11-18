const STORAGE_KEY = "conclave.voice-agent.key";

let inMemoryKey: string | null = null;

const readSession = (): string | null => {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
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
