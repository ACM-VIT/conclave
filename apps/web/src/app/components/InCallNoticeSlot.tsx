"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  InCallNoticeLaneContext,
  placeNoticeLane,
  type LaneObstacle,
  type NoticeLaneMode,
} from "../lib/in-call-notice-lane";

const NOTICE_GAP_PX = 8;
const TOGGLE_HEIGHT_PX = 30;
const COMPACT_HEIGHT_PX = 40;
const REMEASURE_INTERVAL_MS = 600;
const CONTROL_SELECTOR =
  'button, a[href], [role="button"], input, select, textarea';

interface InCallNoticeSlotProps {
  children: ReactNode;
  rightInset?: number;
  bottomInset?: number;
  clearWebinarChrome?: boolean;
  overPanel?: boolean;
}

interface LaneState {
  mode: NoticeLaneMode;
  offset: number;
  count: number;
}

const sameLane = (a: LaneState, b: LaneState) =>
  a.mode === b.mode && a.offset === b.offset && a.count === b.count;

function collectObstacles(slot: HTMLElement, slotRect: DOMRect) {
  const obstacles: LaneObstacle[] = [];
  const root = slot.parentElement;
  if (!root) return obstacles;
  for (const el of root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)) {
    if (slot.contains(el) || el.closest("[data-in-call-controls]")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (
      r.bottom <= slotRect.top ||
      r.top >= slotRect.bottom ||
      r.right <= slotRect.left ||
      r.left >= slotRect.right
    ) {
      continue;
    }
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.pointerEvents === "none") continue;
    if (el.closest('[inert],[aria-hidden="true"]')) continue;
    obstacles.push({
      left: r.left - slotRect.left,
      right: r.right - slotRect.left,
      top: r.top - slotRect.top,
      bottom: r.bottom - slotRect.top,
    });
  }
  return obstacles;
}

function panelHeaderBottom(slotRect: DOMRect) {
  const probe = document.elementFromPoint(window.innerWidth / 2, 1);
  const header = probe?.closest(".fixed")?.firstElementChild;
  const bottom = header ? header.getBoundingClientRect().bottom : 60;
  return bottom - slotRect.top + NOTICE_GAP_PX;
}

export default function InCallNoticeSlot({
  children,
  rightInset = 0,
  bottomInset = 0,
  clearWebinarChrome = false,
  overPanel = false,
}: InCallNoticeSlotProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fullHeightsRef = useRef(new WeakMap<Element, { width: number; height: number }>());
  const [lane, setLane] = useState<LaneState>({ mode: "full", offset: 0, count: 0 });
  const [expanded, setExpanded] = useState(false);
  const [announcements, setAnnouncements] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const laneRef = useRef(lane);
  laneRef.current = lane;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const overPanelRef = useRef(overPanel);
  overPanelRef.current = overPanel;

  useLayoutEffect(() => {
    const slot = slotRef.current;
    const column = columnRef.current;
    const row = rowRef.current;
    const list = listRef.current;
    if (!slot || !column || !row || !list) return;

    const commit = (next: LaneState) => {
      if (next.mode === "full") setExpanded(false);
      setLane((prev) => (sameLane(prev, next) ? prev : next));
    };

    const measure = () => {
      const notices = [...list.children] as HTMLElement[];
      const count = notices.length;
      if (count === 0) {
        commit({ mode: "full", offset: 0, count: 0 });
        return;
      }
      const slotRect = slot.getBoundingClientRect();
      const cssMinTop = parseFloat(getComputedStyle(column).paddingTop) || 0;
      if (overPanelRef.current) {
        const top = panelHeaderBottom(slotRect);
        commit({ mode: "compact", offset: Math.max(0, top - cssMinTop), count });
        return;
      }

      const compactNow = laneRef.current.mode === "compact" && !expandedRef.current;
      const width = row.clientWidth;
      const heights: number[] = [];
      for (const notice of notices) {
        if (!compactNow) {
          const height = notice.offsetHeight;
          fullHeightsRef.current.set(notice, { width, height });
          heights.push(height);
          continue;
        }
        const cached = fullHeightsRef.current.get(notice);
        if (!cached || cached.width !== width) {
          commit({ ...laneRef.current, mode: "full", count });
          return;
        }
        heights.push(cached.height);
      }

      const rowRect = row.getBoundingClientRect();
      const placement = placeNoticeLane(collectObstacles(slot, slotRect), {
        left: rowRect.left - slotRect.left,
        right: rowRect.right - slotRect.left,
        minTop: cssMinTop,
        maxBottom: column.clientHeight,
        count,
        fullHeight:
          heights.reduce((sum, height) => sum + height, 0) +
          NOTICE_GAP_PX * (count - 1),
        collapsedHeight: heights[0] + NOTICE_GAP_PX + TOGGLE_HEIGHT_PX,
        compactHeight: compactNow ? notices[0].offsetHeight : COMPACT_HEIGHT_PX,
      });
      commit({
        mode: placement.mode,
        offset: Math.max(0, placement.top - cssMinTop),
        count,
      });
    };

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const resizes = new ResizeObserver(schedule);
    const observeNotices = () => {
      resizes.disconnect();
      resizes.observe(slot);
      for (const notice of list.children) resizes.observe(notice);
      schedule();
    };
    const listMutations = new MutationObserver(observeNotices);
    listMutations.observe(list, { childList: true, subtree: true, characterData: true });
    const stage = slot.parentElement;
    const stageMutations = new MutationObserver(schedule);
    const revealEvents = ["pointermove", "transitionend", "animationend"] as const;
    if (stage) {
      stageMutations.observe(stage, { childList: true, subtree: true });
      for (const type of revealEvents) {
        stage.addEventListener(type, schedule, { passive: true });
      }
    }
    const interval = window.setInterval(() => {
      if (list.children.length > 0) schedule();
    }, REMEASURE_INTERVAL_MS);
    observeNotices();
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(interval);
      listMutations.disconnect();
      stageMutations.disconnect();
      for (const type of revealEvents) stage?.removeEventListener(type, schedule);
      resizes.disconnect();
    };
  }, []);

  const announce = useCallback((id: string, text: string | null) => {
    setAnnouncements((prev) => {
      if (text === null ? !prev.has(id) : prev.get(id) === text) return prev;
      const next = new Map(prev);
      if (text === null) next.delete(id);
      else next.set(id, text);
      return next;
    });
  }, []);

  const compact = lane.mode === "compact" && !expanded;
  const hidesRest = lane.mode !== "full" && !expanded && lane.count > 1;
  const laneContext = useMemo(() => ({ compact, announce }), [compact, announce]);
  const toggleExpanded = () => setExpanded((value) => !value);

  return (
    <InCallNoticeLaneContext.Provider value={laneContext}>
      <div
        ref={slotRef}
        data-in-call-notices
        data-lane-mode={lane.count > 0 ? lane.mode : undefined}
        className={`@container pointer-events-none absolute inset-x-0 top-0 ${
          overPanel ? "z-[45]" : "z-40"
        }`}
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
            ref={rowRef}
            className="flex min-h-0 w-full max-w-[560px] items-start gap-2"
            style={{ marginTop: lane.offset }}
          >
            <div
              ref={listRef}
              className={`relative flex max-h-full min-h-0 min-w-0 flex-1 flex-col items-center overscroll-contain [&>*+*]:mt-2 ${
                hidesRest
                  ? "overflow-hidden [&>*:nth-child(n+2)]:invisible [&>*:nth-child(n+2)]:absolute [&>*:nth-child(n+2)]:top-0 [&>*:nth-child(n+2)]:mt-0"
                  : "overflow-y-auto"
              } ${expanded ? "pointer-events-auto" : ""}`}
            >
              {children}
            </div>
            {compact && lane.count > 1 ? (
              <button
                type="button"
                onClick={toggleExpanded}
                aria-expanded={false}
                aria-label={`Show ${lane.count - 1} more notices`}
                className="pointer-events-auto h-10 shrink-0 rounded-xl border border-[#fafafa]/10 bg-[#18181b] px-3 text-[12.5px] font-medium text-[#fafafa]/80 transition-colors hover:bg-[#232327] hover:text-[#fafafa]"
              >
                +{lane.count - 1}
              </button>
            ) : null}
          </div>
          {(lane.mode === "collapsed" || expanded) && lane.count > 1 ? (
            <button
              type="button"
              onClick={toggleExpanded}
              aria-expanded={expanded}
              className="pointer-events-auto mt-2 shrink-0 rounded-full border border-[#fafafa]/10 bg-[#18181b] px-3 py-1 text-[12px] font-medium text-[#fafafa]/80 transition-colors hover:bg-[#232327] hover:text-[#fafafa]"
            >
              {expanded ? "Show less" : `+${lane.count - 1} more`}
            </button>
          ) : null}
        </div>
        <div aria-live="polite" className="sr-only">
          {[...announcements].map(([id, text]) => (
            <p key={id}>{text}</p>
          ))}
        </div>
      </div>
    </InCallNoticeLaneContext.Provider>
  );
}
