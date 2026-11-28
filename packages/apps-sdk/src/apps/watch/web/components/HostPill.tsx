import React, { useEffect, useRef, useState } from "react";

type HostPillProps = {
  locked: boolean;
  isAdmin: boolean;
  onSetLocked: (locked: boolean) => void;
};

export function HostPill({ locked, isAdmin, onSetLocked }: HostPillProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(
    null,
  );
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !popoverRef.current?.contains(target) &&
        !buttonRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onScrollOrResize = () => setOpen(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [open]);

  const label = locked ? "Host only" : "Everyone";

  const glyph = locked ? (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  ) : (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </svg>
  );

  if (!isAdmin) {
    return (
      <span
        className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-white/10 px-2.5 text-[11px] font-medium text-[#a1a1aa]"
        title={
          locked
            ? "Only the host controls playback and the queue"
            : "Anyone can control playback and the queue"
        }
      >
        {glyph}
        {label}
      </span>
    );
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          const rect = buttonRef.current?.getBoundingClientRect();
          if (rect) {
            setAnchor({
              top: rect.bottom + 8,
              right: Math.max(8, window.innerWidth - rect.right),
            });
          }
          setOpen((prev) => !prev);
        }}
        aria-expanded={open}
        title="Who can control playback"
        className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-white/10 px-2.5 text-[11px] font-medium text-[#fafafa] transition-colors hover:bg-white/[0.06]"
      >
        {glyph}
        {label}
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{
            transform: open ? "rotate(180deg)" : undefined,
            transition: "transform 150ms ease",
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && anchor ? (
        <div
          ref={popoverRef}
          className="w-60 rounded-xl border border-white/10 p-3"
          style={{
            position: "fixed",
            top: anchor.top,
            right: anchor.right,
            zIndex: 70,
            backgroundColor: "#18181b",
          }}
        >
          <button
            type="button"
            onClick={() => onSetLocked(!locked)}
            className="flex w-full cursor-pointer items-center justify-between gap-3 text-left"
            role="switch"
            aria-checked={!locked}
          >
            <span>
              <span className="block text-[12.5px] font-medium text-[#fafafa]">
                Everyone can control
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug text-[#71717a]">
                Play, pause, seek and edit the queue. When off, only hosts can.
              </span>
            </span>
            <span
              className="relative h-5 w-9 shrink-0 rounded-full transition-colors"
              style={{ backgroundColor: locked ? "#33333b" : "#F95F4A" }}
            >
              <span
                className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-[left]"
                style={{ left: locked ? 2 : 18 }}
              />
            </span>
          </button>
        </div>
      ) : null}
    </>
  );
}
