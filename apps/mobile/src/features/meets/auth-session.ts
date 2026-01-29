import AsyncStorage from "@react-native-async-storage/async-storage";

type AuthUser = {
  id?: string;
  email?: string | null;
  name?: string | null;
} | null;

const STORAGE_KEY = "conclave:auth-user";

let cachedUser: AuthUser = null;
let hasHydrated = false;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const getNullableString = (
  record: Record<string, unknown>,
  key: string
): string | null | undefined => {
  const value = record[key];
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
};

const sanitizeUser = (value: unknown): AuthUser => {
  if (!isRecord(value)) return null;
  const id = getString(value, "id");
  const email = getNullableString(value, "email");
  const name = getNullableString(value, "name");
  if (!id && !email && !name) return null;
  return { id, email, name };
};

export function getCachedUser(): AuthUser {
  return cachedUser;
}

export async function hydrateCachedUser(): Promise<AuthUser> {
  if (hasHydrated) return cachedUser;
  hasHydrated = true;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return cachedUser;
    cachedUser = sanitizeUser(JSON.parse(raw));
  } catch {
    cachedUser = null;
  }
  return cachedUser;
}

export async function setCachedUser(user: AuthUser): Promise<void> {
  cachedUser = user;
  try {
    if (user) {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    } else {
      await AsyncStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore persistence failures; we'll fall back to in-memory cache.
  }
}
