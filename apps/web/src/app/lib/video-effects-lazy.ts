export type PrewarmVideoEffectsAssetsOptions = Parameters<
  typeof import("../hooks/useVideoEffects").prewarmVideoEffectsAssets
>[0];

export type PrewarmVideoEffectsRuntimeOptions = Parameters<
  typeof import("../hooks/useVideoEffects").prewarmVideoEffectsRuntime
>[0];

export const prewarmVideoEffectsAssetsDeferred = async (
  options: PrewarmVideoEffectsAssetsOptions,
) => {
  const { prewarmVideoEffectsAssets } = await import(
    "../hooks/useVideoEffects"
  );
  await prewarmVideoEffectsAssets(options);
};

export const prewarmVideoEffectsRuntimeDeferred = async (
  options: PrewarmVideoEffectsRuntimeOptions,
) => {
  const { prewarmVideoEffectsRuntime } = await import(
    "../hooks/useVideoEffects"
  );
  await prewarmVideoEffectsRuntime(options);
};
