"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import {
  AI_PROVIDERS,
  AI_RESPONSE_MODELS,
  LIVE_TRANSCRIPT_TRANSCRIPTION_MODELS,
  type AiProvider,
} from "@conclave/ai/models";
import {
  AI_FEATURES,
  AI_GENERATION_LIMITS,
  featureProvider,
  resolveAiFeatureSettings,
  type AiFeature,
  type AiFeatureSettings,
} from "@conclave/ai/room-settings";
import type { RoomAiController } from "../hooks/useRoomAi";
import { useAiModels } from "../hooks/useAiModels";
import AiModelSelect from "./AiModelSelect";

const fieldClass =
  "mt-1.5 w-full min-w-0 rounded-lg border border-white/10 bg-black/20 px-2.5 py-2 text-[12px] text-[#fafafa] outline-none focus:border-[#4F9CF9]/60 disabled:opacity-40";

export default function RoomAiFeatureSettings({
  controller,
}: {
  controller: RoomAiController;
}) {
  const [expanded, setExpanded] = useState<AiFeature | null>(null);
  return (
    <div className="divide-y divide-white/10">
      {(Object.keys(AI_FEATURES) as AiFeature[]).map((feature) => {
        const settings = resolveAiFeatureSettings(
          {
            CONCLAVE_ASSISTANT_MODEL:
              controller.state.assistantModel ?? undefined,
          },
          feature,
          controller.state.features ?? {},
        );
        const provider = featureProvider(feature, settings.model);
        const available =
          provider === "elevenlabs"
            ? null
            : Boolean(controller.state[provider].source);
        const status = !settings.enabled
          ? "Disabled"
          : !controller.ready
            ? "Loading"
            : available === false
              ? "Key needed"
              : "Enabled";
        const modelLabel =
          [...AI_RESPONSE_MODELS, ...LIVE_TRANSCRIPT_TRANSCRIPTION_MODELS].find(
            (model) => model.id === settings.model,
          )?.label ??
          (
            {
              "omni-moderation-latest": "Omni Moderation",
              "gpt-realtime-1.5": "GPT Realtime 1.5",
              "gpt-realtime": "GPT Realtime",
              eleven_multilingual_v2: "Multilingual v2",
              eleven_flash_v2_5: "Flash v2.5",
              eleven_turbo_v2_5: "Turbo v2.5",
              eleven_v3: "Eleven v3",
            } as Record<string, string>
          )[settings.model] ??
          settings.model;
        return (
          <div key={feature}>
            <button
              type="button"
              aria-expanded={expanded === feature}
              aria-label={`${AI_FEATURES[feature].label} settings`}
              title={status}
              onClick={() => setExpanded(expanded === feature ? null : feature)}
              className="flex w-full items-center gap-3 py-3 text-left"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-medium text-[#fafafa]">
                  {AI_FEATURES[feature].label}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-[#a1a1aa]">
                  {AI_PROVIDERS[provider].label} · {modelLabel}
                </span>
              </span>
              {!settings.enabled ? (
                <span className="text-[10.5px] text-[#71717a]">Off</span>
              ) : null}
              <ChevronDown
                size={14}
                className={`shrink-0 text-[#a1a1aa] transition-transform ${expanded === feature ? "rotate-180" : ""}`}
              />
            </button>
            {expanded === feature ? (
              <FeatureEditor
                key={feature}
                feature={feature}
                settings={settings}
                controller={controller}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function FeatureEditor({
  feature,
  settings,
  controller,
}: {
  feature: AiFeature;
  settings: AiFeatureSettings;
  controller: RoomAiController;
}) {
  const catalog = useAiModels(controller);
  const [draft, setDraft] = useState(settings);
  const savedSettings = JSON.stringify(settings);
  useEffect(() => {
    setDraft(JSON.parse(savedSettings) as AiFeatureSettings);
  }, [savedSettings]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const text = AI_FEATURES[feature].kind === "text";
  const provider = featureProvider(feature, draft.model);
  const owns = (name: AiProvider): boolean => {
    if (name === "elevenlabs") return false;
    const status = controller.state[name];
    return (
      typeof status === "object" &&
      status !== null &&
      "source" in status &&
      status.source === "room" &&
      "ownerId" in status &&
      status.ownerId === controller.currentUserId
    );
  };
  const canEdit =
    controller.isAdmin || (provider !== "elevenlabs" && owns(provider));
  const canSelect =
    controller.isAdmin ||
    (text && (owns("openai") || owns("anthropic"))) ||
    (feature === "transcription" && (owns("openai") || owns("sarvam"))) ||
    canEdit;
  const disabled = pending || !controller.ready || !controller.connected;
  const update = <K extends keyof AiFeatureSettings>(
    key: K,
    value: AiFeatureSettings[K],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
    setError(null);
  };
  const number = (
    label: string,
    key: "maxOutputTokens" | "researchTokens" | "timeoutMs" | "maxSearchUses",
    min: number,
    max: number,
    scale = 1,
  ) => (
    <label className="min-w-0 text-[11px] text-[#a1a1aa]">
      {label}
      <input
        aria-label={label}
        type="number"
        min={min / scale}
        max={max / scale}
        step={key === "timeoutMs" ? 0.5 : 1}
        value={draft[key] / scale}
        onChange={(event) => update(key, Number(event.target.value) * scale)}
        className={fieldClass}
      />
    </label>
  );
  const staticModels =
    feature === "transcription"
      ? LIVE_TRANSCRIPT_TRANSCRIPTION_MODELS.map((model) => ({
          id: model.id,
          label: model.label,
        }))
      : feature === "images"
        ? [{ id: "omni-moderation-latest", label: "Omni Moderation" }]
        : feature === "voice"
          ? [
              { id: "gpt-realtime-1.5", label: "GPT Realtime 1.5" },
              { id: "gpt-realtime", label: "GPT Realtime" },
            ]
          : [
              { id: "eleven_multilingual_v2", label: "Multilingual v2" },
              { id: "eleven_flash_v2_5", label: "Flash v2.5" },
              { id: "eleven_turbo_v2_5", label: "Turbo v2.5" },
              { id: "eleven_v3", label: "Eleven v3" },
            ];
  return (
    <form
      className="space-y-3 pb-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!canEdit || disabled || !controller.configureFeature) return;
        setPending(true);
        setError(null);
        const failure = await controller.configureFeature(feature, draft);
        setPending(false);
        setError(failure);
        setSaved(!failure);
      }}
    >
      <fieldset disabled={disabled} className="min-w-0 space-y-3">
        {text ? (
          <AiModelSelect
            label="Model"
            value={draft.model}
            disabled={!canSelect}
            models={catalog.models.map((model) => ({
              ...model,
              disabled: !controller.isAdmin && !owns(model.provider),
            }))}
            loading={catalog.loading}
            error={catalog.error}
            onRefresh={catalog.refresh}
            onChange={(value) => update("model", value)}
          />
        ) : (
          <label className="block text-[11px] text-[#a1a1aa]">
            Model
            <select
              aria-label="Model"
              disabled={!canSelect}
              value={draft.model}
              onChange={(event) => update("model", event.target.value)}
              className={fieldClass}
            >
              {!staticModels.some((model) => model.id === draft.model) ? (
                <option value={draft.model}>{draft.model}</option>
              ) : null}
              {staticModels.map((model) => (
                <option key={model.id} value={model.id} disabled={!controller.isAdmin && !owns(featureProvider(feature, model.id))}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <fieldset disabled={!canEdit} className="space-y-3">
          <label className="flex items-center justify-between text-[12px] text-[#d4d4d8]">
            Enabled
            <input
              type="checkbox"
              aria-label="Enabled"
              checked={draft.enabled}
              onChange={(event) => update("enabled", event.target.checked)}
              className="accent-[#4F9CF9]"
            />
          </label>
          {text ? (
            <details className="rounded-lg border border-white/10 px-3">
              <summary className="cursor-pointer py-2 text-[11px] text-[#a1a1aa]">
                Generation options
              </summary>
              <div className="space-y-3 pb-3">
                <div className="grid grid-cols-2 gap-3">
                  {number(
                    "Output tokens",
                    "maxOutputTokens",
                    128,
                    AI_GENERATION_LIMITS.maxOutputTokens,
                  )}
                  {number(
                    "Research tokens",
                    "researchTokens",
                    128,
                    AI_GENERATION_LIMITS.maxOutputTokens,
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-[11px] text-[#a1a1aa]">
                    Reasoning
                    <select
                      aria-label="Reasoning"
                      value={draft.reasoningEffort}
                      onChange={(event) =>
                        update(
                          "reasoningEffort",
                          event.target
                            .value as AiFeatureSettings["reasoningEffort"],
                        )
                      }
                      className={fieldClass}
                    >
                      {["default", "low", "medium", "high", "xhigh", "max"].map(
                        (value) => (
                          <option key={value} value={value}>
                            {value === "default" ? "Model default" : value}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label className="text-[11px] text-[#a1a1aa]">
                    Answer length
                    <select
                      aria-label="Answer length"
                      value={draft.verbosity}
                      onChange={(event) =>
                        update(
                          "verbosity",
                          event.target.value as AiFeatureSettings["verbosity"],
                        )
                      }
                      className={fieldClass}
                    >
                      {["default", "low", "medium", "high"].map((value) => (
                        <option key={value} value={value}>
                          {value === "default" ? "Model default" : value}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="flex items-center justify-between text-[12px] text-[#d4d4d8]">
                  Web search
                  <input
                    type="checkbox"
                    aria-label="Web search"
                    checked={draft.searchEnabled}
                    onChange={(event) =>
                      update("searchEnabled", event.target.checked)
                    }
                    className="accent-[#4F9CF9]"
                  />
                </label>
                {draft.searchEnabled
                  ? number("Searches per request", "maxSearchUses", 1, 30)
                  : null}
              </div>
            </details>
          ) : null}
          {number(
            "Timeout (seconds)",
            "timeoutMs",
            AI_GENERATION_LIMITS.minTimeoutMs,
            AI_GENERATION_LIMITS.maxTimeoutMs,
            1000,
          )}
          {text || feature === "voice" ? (
            <details className="text-[11px] text-[#a1a1aa]">
              <summary className="cursor-pointer py-1">
                Custom instructions
              </summary>
              <textarea
                aria-label="Custom instructions"
                value={draft.instructions}
                maxLength={32_000}
                rows={4}
                onChange={(event) => update("instructions", event.target.value)}
                className={`${fieldClass} resize-y`}
              />
            </details>
          ) : null}
        </fieldset>
      </fieldset>
      {feature === "transcription" || feature === "voice" ? (
        <p className="text-[10.5px] text-[#a1a1aa]">
          Applies when audio restarts.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[11px] text-red-300">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={disabled || !canEdit || !controller.configureFeature}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#F95F4A] px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40"
        >
          {pending ? <Loader2 size={12} className="animate-spin" /> : null}
          {saved ? "Saved" : "Save"}
        </button>
        <button
          type="button"
          disabled={disabled || !canEdit}
          onClick={() =>
            setDraft({
              ...resolveAiFeatureSettings({}, feature, {}),
              model: draft.model,
            })
          }
          className="text-[11px] text-[#a1a1aa] hover:text-white"
        >
          Reset options
        </button>
      </div>
    </form>
  );
}
