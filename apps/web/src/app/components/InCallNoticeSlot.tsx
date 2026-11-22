"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

const NOTICE_GAP_PX = 8;

interface InCallNoticeSlotProps {
  children: ReactNode;
  rightInset?: number;
  bottomInset?: number;
  clearWebinarChrome?: boolean;
}

interface StackFit {
  count: number;
  overflows: boolean;
}

export default function InCallNoticeSlot({
  children,
  rightInset = 0,
  bottomInset = 0,
  clearWebinarChrome = false,
}: InCallNoticeSlotProps) {
  const columnRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<StackFit>({ count: 0, overflows: false });
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const column = columnRef.current;
    const list = listRef.current;
    if (!column || !list) return;
    const measure = () => {
      const notices = [...list.children] as HTMLElement[];
      const needed =
        notices.reduce((sum, notice) => sum + notice.offsetHeight, 0) +
        NOTICE_GAP_PX * Math.max(0, notices.length - 1);
      const room =
        column.clientHeight -
        (parseFloat(getComputedStyle(column).paddingTop) || 0);
      const overflows = notices.length > 1 && needed > room;
      if (!overflows) setExpanded(false);
      setFit((prev) =>
        prev.count === notices.length && prev.overflows === overflows
          ? prev
          : { count: notices.length, overflows },
      );
    };
    const resizes = new ResizeObserver(measure);
    const observeNotices = () => {
      resizes.disconnect();
      resizes.observe(column);
      for (const notice of list.children) resizes.observe(notice);
      measure();
    };
    const mutations = new MutationObserver(observeNotices);
    mutations.observe(list, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    observeNotices();
    return () => {
      mutations.disconnect();
      resizes.disconnect();
    };
  }, []);

  const collapsed = fit.overflows && !expanded;

  return (
    <div
      data-in-call-notices
      className="@container pointer-events-none absolute inset-x-0 top-0 z-40"
      style={{
        right: rightInset,
        bottom: clearWebinarChrome
          ? "calc(env(safe-area-inset-bottom, 0px) + 68px)"
          : bottomInset,
      }}
    >
      <div
        ref={columnRef}
        className="flex h-full flex-col items-center px-3 pt-3 @3xl:px-16 @5xl:px-40"
        style={{
          paddingTop: clearWebinarChrome
            ? "calc(env(safe-area-inset-top, 0px) + 92px)"
            : undefined,
        }}
      >
        <div
          ref={listRef}
          className={`relative flex min-h-0 w-full flex-col items-center overscroll-contain [&>*+*]:mt-2 ${
            collapsed
              ? "overflow-hidden [&>*:nth-child(n+2)]:invisible [&>*:nth-child(n+2)]:absolute [&>*:nth-child(n+2)]:top-0 [&>*:nth-child(n+2)]:mt-0"
              : "overflow-y-auto"
          } ${expanded ? "pointer-events-auto" : ""}`}
        >
          {children}
        </div>
        {fit.overflows ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className="pointer-events-auto mt-2 shrink-0 rounded-full border border-[#fafafa]/10 bg-[#18181b] px-3 py-1 text-[12px] font-medium text-[#fafafa]/80 transition-colors hover:bg-[#232327] hover:text-[#fafafa]"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
          >
            {expanded ? "Show less" : `+${fit.count - 1} more`}
          </button>
        ) : null}
      </div>
    </div>
  );
}
