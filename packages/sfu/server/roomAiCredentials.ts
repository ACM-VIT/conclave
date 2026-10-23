import {
  AI_PROVIDERS,
  getProviderApiKey,
  isProviderApiKey,
  AI_RESPONSE_MODELS,
  getResponseProvider,
  isResponseModel,
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
  #assistantModel: string | null = null;

  get assistantModel(): string | null {
    return this.#assistantModel;
  }

  setModel(model: string, actorId: string, isHost: boolean): void {
    if (!isResponseModel(model))
      throw new Error("Choose a supported assistant model.");
    this.assertOwner(getResponseProvider(model), actorId, isHost);
    this.#assistantModel = model;
  }

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
    // The first text-provider contribution selects its model visibly for the room.
    if (!this.#assistantModel && provider !== "sarvam") {
      this.#assistantModel = AI_RESPONSE_MODELS.find(
        (model) => model.provider === provider,
      )!.id;
    }
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
    return {
      ...Object.fromEntries(
        ROOM_AI_PROVIDERS.map((provider) => [
          provider,
          getProviderApiKey(env, provider)
            ? { source: "deployment" }
            : this.#keys.has(provider)
              ? { source: "room", ownerId: this.#keys.get(provider)!.ownerId }
              : { source: null },
        ]),
      ),
      assistantModel: this.#assistantModel,
    } as RoomAiState;
  }

  clear(): void {
    this.#keys.clear();
    this.#assistantModel = null;
  }
}
