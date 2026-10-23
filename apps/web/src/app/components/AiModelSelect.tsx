"use client";

import { useId } from "react";
import { ChevronDown } from "lucide-react";
import { AI_PROVIDERS, type AiTextProvider } from "@conclave/ai/models";

export default function AiModelSelect({
  value,
  onChange,
  models,
  disabled = false,
  label = "Assistant model",
}: {
  value: string;
  onChange: (value: string) => void;
  models: readonly {
    id: string;
    label: string;
    description: string;
    provider: AiTextProvider;
  }[];
  disabled?: boolean;
  label?: string;
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
        {selected ? (
          <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-[#a1a1aa]">
            {AI_PROVIDERS[selected.provider].label}
          </span>
        ) : null}
      </div>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-describedby={`${id}-description`}
          className="h-10 w-full appearance-none rounded-lg border border-white/10 bg-[#141416] pl-3 pr-9 text-[12px] text-[#fafafa] outline-none transition-colors focus:border-[#F95F4A]/60 focus-visible:ring-2 focus-visible:ring-[#F95F4A]/20 disabled:opacity-60"
        >
          {providers.map((provider) => (
            <optgroup key={provider} label={AI_PROVIDERS[provider].label}>
              {models
                .filter((model) => model.provider === provider)
                .map((model) => (
                  <option key={model.id} value={model.id}>
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
      <p id={`${id}-description`} className="sr-only">
        {selected
          ? `${AI_PROVIDERS[selected.provider].label} · ${selected.description}`
          : "Choose an assistant model."}
      </p>
    </div>
  );
}
