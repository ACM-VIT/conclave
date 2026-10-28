import { roomAiFeatureDefaults } from "./roomAiSettings.js";
import {
  AI_PROVIDERS,
  getProviderApiKey,
  isProviderApiKey,
  AI_RESPONSE_MODELS,
  getResponseProvider,
  isResponseModel,
  type AiEnvironment,
  type AiTextProvider,
  type AiModelCatalog,
} from "@conclave/ai/models";
import { fetchAiModelCatalog } from "@conclave/ai/server";
import { featureProvider, resolveAiFeatureSettings, validateFeaturePatch, type AiFeature, type RoomAiFeatureSettings } from "@conclave/ai/room-settings";
import {
  ROOM_AI_PROVIDERS,
  type RoomAiProvider,
  type RoomAiState,
} from "@conclave/ai/room";

export class RoomAiCredentials {
  // Private fields cannot leak through room snapshots or JSON serialization.
  #keys = new Map<RoomAiProvider, { apiKey: string; ownerId: string }>();
  #assistantModel: string | null = null;
  #features: RoomAiFeatureSettings = {};
  #keyRevision = 0;

  get keyRevision(): number {
    return this.#keyRevision;
  }
  #catalogs = new Map<
    AiTextProvider,
    {
      apiKey: string;
      expiresAt: number;
      result: Promise<AiModelCatalog>;
    }
  >();

  async models(
    provider: AiTextProvider,
    env: AiEnvironment,
    options: { apiKey?: string; refresh?: boolean } = {},
  ): Promise<AiModelCatalog> {
    const apiKey =
      options.apiKey ??
      (getProviderApiKey(env, provider) || this.get(provider) || "");
    // Personal keys are used for this request only, never retained on the room.
    if (options.apiKey !== undefined)
      return fetchAiModelCatalog({ provider, apiKey, env });
    const cached = this.#catalogs.get(provider);
    if (
      !options.refresh &&
      cached?.apiKey === apiKey &&
      cached.expiresAt > Date.now()
    )
      return cached.result;
    const result = fetchAiModelCatalog({ provider, apiKey, env });
    this.#catalogs.set(provider, {
      apiKey,
      expiresAt: Date.now() + 300_000,
      result,
    });
    return result;
  }

  get assistantModel(): string | null {
    return this.#assistantModel;
  }

  get hasAssistantModelSelection(): boolean {
    return this.#assistantModel !== null || this.#features.assistant?.model !== undefined;
  }

  get featureSettings(): RoomAiFeatureSettings {
    return structuredClone(this.#features);
  }

  effectiveFeatureSettings(env: AiEnvironment = {}): RoomAiFeatureSettings {
    return roomAiFeatureDefaults({...env, ...(this.#assistantModel ? {CONCLAVE_ASSISTANT_MODEL: this.#assistantModel} : {})}, this.featureSettings);
  }

  configureFeature(feature: AiFeature, input: unknown, actorId: string, isHost: boolean, env: AiEnvironment = {}): void {
    const patch = validateFeaturePatch(feature, input);
    const current = resolveAiFeatureSettings({ ...env, ...(this.#assistantModel ? { CONCLAVE_ASSISTANT_MODEL: this.#assistantModel } : {}) }, feature, this.effectiveFeatureSettings(env));
    const provider = featureProvider(feature, patch.model ?? current.model);
    const ownsKey = !getProviderApiKey(env, provider) && provider !== "elevenlabs" && this.#keys.get(provider)?.ownerId === actorId;
    if (!isHost && !ownsKey) throw new Error("Only a host or this provider's key contributor can change these settings.");
    this.#features[feature] = { ...this.#features[feature], ...patch };
  }

  setModel(
    model: string,
    actorId: string,
    isHost: boolean,
    env: AiEnvironment = {},
  ): void {
    if (!isResponseModel(model))
      throw new Error("Choose a supported assistant model.");
    const provider = getResponseProvider(model);
    const ownsEffectiveKey =
      !getProviderApiKey(env, provider) &&
      this.#keys.get(provider)?.ownerId === actorId;
    if (!isHost && !ownsEffectiveKey) {
      throw new Error(
        "Only a host or this provider's room-key contributor can change its model.",
      );
    }
    this.#assistantModel = model;
    this.#features.assistant = { ...this.#features.assistant, model };
  }

  get(provider: RoomAiProvider): string | undefined {
    return this.#keys.get(provider)?.apiKey;
  }

  set(
    provider: RoomAiProvider,
    apiKey: string,
    actorId: string,
    isHost: boolean,
    env: AiEnvironment = {},
    options: { selectDefaultModel?: boolean } = {},
  ): void {
    const key = apiKey.trim();
    if (key.length > 512 || !isProviderApiKey(provider, key))
      throw new Error(`Enter a valid ${AI_PROVIDERS[provider].label} API key.`);
    this.assertOwner(provider, actorId, isHost);
    this.#keys.set(provider, { apiKey: key, ownerId: actorId });
    ++this.#keyRevision;
    if (provider !== "sarvam") this.#catalogs.delete(provider);
    // The first text-provider contribution selects its model visibly for the room.
    if (
      !this.hasAssistantModelSelection &&
      options.selectDefaultModel !== false &&
      provider !== "sarvam" &&
      !getProviderApiKey(env, provider)
    ) {
      this.#assistantModel = AI_RESPONSE_MODELS.find(
        (model) => model.provider === provider,
      )!.id;
    }
  }

  remove(provider: RoomAiProvider, actorId: string, isHost: boolean): void {
    this.assertOwner(provider, actorId, isHost);
    this.#keys.delete(provider);
    ++this.#keyRevision;
    if (provider !== "sarvam") this.#catalogs.delete(provider);
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
    const assistantModel = this.#assistantModel || (env.CONCLAVE_ASSISTANT_MODEL && isResponseModel(env.CONCLAVE_ASSISTANT_MODEL) ? env.CONCLAVE_ASSISTANT_MODEL : null);
    const features = this.effectiveFeatureSettings(env);
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
      assistantModel,
      ...(Object.keys(features).length ? { features } : {}),
    } as RoomAiState;
  }

  clear(): void {
    this.#keys.clear();
    ++this.#keyRevision;
    this.#catalogs.clear();
    this.#assistantModel = null;
    this.#features = {};
  }
}
