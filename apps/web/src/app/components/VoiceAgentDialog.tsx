"use client";

import { AudioLines, Eye, EyeOff, Loader2 } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { color } from "@conclave/ui-tokens";

/**
 * Bring-your-own-key dialog for the AI voice agent. Collects the host's
 * OpenAI API key, then stays open in a connecting state until the agent is
 * live so start failures land inline instead of in a toast. The parent owns
 * start/stop and closes the dialog once the agent connects.
 */
export default function VoiceAgentDialog({
  open,
  isStarting,
  error,
  onStart,
  onClose,
}: {
  open: boolean;
  /** Agent is connecting; the dialog shows progress instead of the form. */
  isStarting: boolean;
  /** Start failure to show inline (key rejection, connection errors). */
  error: string | null;
  onStart: (apiKey: string, remember: boolean) => void;
  /** Dismiss; the parent aborts an in-flight start. */
  onClose: () => void;
}) {
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [remember, setRemember] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setKey("");
    setShowKey(false);
    setLocalError(null);
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  if (!open) return null;

  const shownError = localError ?? error;

  const submit = () => {
    if (isStarting) return;
    const trimmed = key.trim();
    if (!trimmed) {
      setLocalError("Enter your OpenAI API key.");
      return;
    }
    if (!trimmed.startsWith("sk-")) {
      setLocalError("OpenAI keys start with sk-.");
      return;
    }
    setLocalError(null);
    onStart(trimmed, remember);
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  // Connecting has no form to correct, so a rejected key returns us to the
  // form via the parent; here we only show progress.
  const connecting = isStarting;

  return (
    <div
      className="fixed inset-0 z-[145] flex items-center justify-center px-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div aria-hidden className="absolute inset-0 -z-10 bg-black/60" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="voice-agent-dialog-title"
        className="w-full max-w-[380px] rounded-2xl border p-5 origin-center will-change-transform animate-[meet-popover-in_150ms_cubic-bezier(0.22,1,0.36,1)]"
        style={{
          backgroundColor: color.surfaceRaised,
          borderColor: color.border,
        }}
      >
        <div className="flex items-center gap-2">
          <AudioLines size={17} strokeWidth={2} style={{ color: color.accent }} />
          <h2
            id="voice-agent-dialog-title"
            className="text-[14.5px] font-semibold"
            style={{ color: color.text }}
          >
            {connecting ? "Starting voice agent" : "Voice agent"}
          </h2>
        </div>

        {connecting ? (
          <div className="mt-4 flex items-center gap-2.5">
            <Loader2
              size={16}
              strokeWidth={2.25}
              className="animate-spin"
              style={{ color: color.accent }}
            />
            <p className="text-[13px]" style={{ color: color.textMuted }}>
              Connecting and joining the call.
            </p>
          </div>
        ) : (
          <>
            <p className="mt-1 text-[12.5px]" style={{ color: color.textMuted }}>
              An AI assistant that listens and answers by voice. Uses your
              OpenAI key, sent only to OpenAI.
            </p>

            <div
              className="mt-4 flex items-center gap-2 rounded-xl border px-3 focus-within:border-white/35"
              style={{
                borderColor: shownError ? color.danger : color.border,
                backgroundColor: color.bgAlt,
              }}
            >
              <input
                ref={inputRef}
                type={showKey ? "text" : "password"}
                value={key}
                onChange={(event) => {
                  setKey(event.target.value);
                  setLocalError(null);
                }}
                onKeyDown={onInputKeyDown}
                placeholder="sk-..."
                aria-label="OpenAI API key"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
                className="min-w-0 flex-1 bg-transparent py-2.5 text-[13px] outline-none placeholder:text-[#fafafa]/35"
                style={{ color: color.text }}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? "Hide API key" : "Show API key"}
                className="shrink-0"
                style={{ color: color.textFaint }}
              >
                {showKey ? (
                  <EyeOff size={15} strokeWidth={1.75} />
                ) : (
                  <Eye size={15} strokeWidth={1.75} />
                )}
              </button>
            </div>
            {shownError ? (
              <p
                className="mt-2 text-[12px]"
                style={{ color: color.danger }}
                role="alert"
              >
                {shownError}
              </p>
            ) : null}

            <label
              className="mt-3 flex cursor-pointer items-center gap-2 text-[12px]"
              style={{ color: color.textMuted }}
            >
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
                className="h-3.5 w-3.5 accent-[#F95F4A]"
              />
              Remember for this tab
            </label>
          </>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border px-3.5 py-2 text-[12.5px] font-medium transition-colors hover:border-white/30"
            style={{ borderColor: color.border, color: color.textMuted }}
          >
            Cancel
          </button>
          {!connecting ? (
            <button
              type="button"
              onClick={submit}
              className="rounded-xl px-4 py-2 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: color.accent }}
            >
              Start
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
