import {
  AI_PROVIDERS,
  getProviderApiKey,
  isProviderApiKey,
  type AiEnvironment,
} from "@conclave/ai/models";
import {
  ROOM_AI_PROVIDERS,
  type RoomAiProvider,
  type RoomAiState,
} from "@conclave/ai/room";

export class RoomAiCredentials {
  // Private fields cannot leak through room snapshots or JSON serialization.
  #keys = new Map<RoomAiProvider, { apiKey: string; ownerId: string }>();

  get(provider: RoomAiProvider): string | undefined {
    return this.#keys.get(provider)?.apiKey;
  }

  set(
    provider: RoomAiProvider,
    apiKey: string,
    actorId: string,
    isHost: boolean,
  ): void {
    const key = apiKey.trim();
    if (key.length > 512 || !isProviderApiKey(provider, key))
      throw new Error(`Enter a valid ${AI_PROVIDERS[provider].label} API key.`);
    this.assertOwner(provider, actorId, isHost);
    this.#keys.set(provider, { apiKey: key, ownerId: actorId });
  }

  remove(provider: RoomAiProvider, actorId: string, isHost: boolean): void {
    this.assertOwner(provider, actorId, isHost);
    this.#keys.delete(provider);
  }

  private assertOwner(
    provider: RoomAiProvider,
    actorId: string,
    isHost: boolean,
  ): void {
    const existing = this.#keys.get(provider);
    if (existing && existing.ownerId !== actorId && !isHost)
      throw new Error("Only the key's contributor or a host can change it.");
  }

  status(env: AiEnvironment): RoomAiState {
    return Object.fromEntries(
      ROOM_AI_PROVIDERS.map((provider) => [
        provider,
        getProviderApiKey(env, provider)
          ? { source: "deployment" }
          : this.#keys.has(provider)
            ? { source: "room", ownerId: this.#keys.get(provider)!.ownerId }
            : { source: null },
      ]),
    ) as RoomAiState;
  }

  clear(): void {
    this.#keys.clear();
  }
}
