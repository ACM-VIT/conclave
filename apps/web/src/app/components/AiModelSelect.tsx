"use client";

import { useId } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import {
  AI_PROVIDERS,
  getTranscriptResponseModelConfig,
  type AiTextProvider,
} from "@conclave/ai/models";

export default function AiModelSelect({
  value,
  onChange,
  models,
  disabled = false,
  label = "Assistant model",
  placeholder,
  loading = false,
  error,
  onRefresh,
}: {
  value: string;
  onChange: (value: string) => void;
  models: readonly {
    id: string;
    label: string;
    description: string;
    provider: AiTextProvider;
    disabled?: boolean;
  }[];
  disabled?: boolean;
  label?: string;
  placeholder?: string;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
}) {
  const id = useId();
  const selected = models.find((model) => model.id === value);
  const providers = [...new Set(models.map((model) => model.provider))];
  return (
    <div className="space-y-1.5 text-left">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-[12px] font-medium text-[#d4d4d8]">
          {label}
        </label>
        <span className="flex items-center gap-2">
          {selected ? (
            <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-[#a1a1aa]">
              {AI_PROVIDERS[selected.provider].label}
            </span>
          ) : null}
          {onRefresh ? (
            <button
              type="button"
              onClick={onRefresh}
              disabled={disabled || loading}
              title={error || "Refresh available models"}
              aria-label="Refresh available models"
              className="rounded-md p-1 text-[#a1a1aa] hover:bg-white/[0.06] hover:text-white disabled:opacity-50"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            </button>
          ) : null}
        </span>
      </div>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-describedby={`${id}-description${error ? ` ${id}-error` : ""}`}
          aria-busy={loading}
          className="h-10 w-full appearance-none rounded-lg border border-white/10 bg-[#141416] pl-3 pr-9 text-[12px] text-[#fafafa] outline-none transition-colors focus:border-[#F95F4A]/60 focus-visible:ring-2 focus-visible:ring-[#F95F4A]/20 disabled:opacity-60"
        >
          {placeholder ? (
            <option value="" disabled>
              {placeholder}
            </option>
          ) : null}
          {value && !selected ? (
            <option value={value} disabled>
              {getTranscriptResponseModelConfig(value).label} (not listed)
            </option>
          ) : null}
          {providers.map((provider) => (
            <optgroup key={provider} label={AI_PROVIDERS[provider].label}>
              {models
                .filter((model) => model.provider === provider)
                .map((model) => (
                  <option
                    key={model.id}
                    value={model.id}
                    disabled={model.disabled}
                  >
                    {model.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          size={14}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#a1a1aa]"
        />
      </div>
      {error ? (
        <p
          id={`${id}-error`}
          role="status"
          className="text-[10px] leading-relaxed text-amber-200/80"
        >
          {error}
        </p>
      ) : null}
      <p id={`${id}-description`} className="sr-only">
        {selected
          ? `${AI_PROVIDERS[selected.provider].label} · ${selected.description}`
          : "Choose an assistant model."}
      </p>
    </div>
  );
}
