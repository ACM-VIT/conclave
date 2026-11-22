"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  findLaneGap,
  InCallNoticeLaneContext,
  placeNoticeLane,
  type LaneObstacle,
} from "../lib/in-call-notice-lane";

const NOTICE_GAP_PX = 8;
const TOGGLE_HEIGHT_PX = 36;
const COMPACT_HEIGHT_PX = 44;
const MAX_PEEKS = 2;
const PANEL_NOTICE_SHARE = 0.5;
const MAX_LANE_WIDTH_PX = 560;

const PEEK_STEP_PX = 6;
const PEEK_SHRINK = 0.07;
const PEEK_OPACITY = [0.6, 0.35] as const;
const REMEASURE_INTERVAL_MS = 600;
const POINTER_REMEASURE_MS = 150;
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
  compact: boolean;
  offset: number;
  count: number;
  room: number;
  narrow?: { left: number; width: number };
  bare?: boolean;
  cramped?: boolean;
}

const sameLane = (a: LaneState, b: LaneState) =>
  a.compact === b.compact &&
  a.offset === b.offset &&
  a.count === b.count &&
  a.room === b.room &&
  a.narrow?.left === b.narrow?.left &&
  a.narrow?.width === b.narrow?.width &&
  a.bare === b.bare &&
  a.cramped === b.cramped;

const narrowLane = (
  placement: { left?: number; right?: number },
  padLeft: number,
): LaneState["narrow"] =>
  placement.left === undefined || placement.right === undefined
    ? undefined
    : { left: Math.round(placement.left - padLeft), width: Math.round(placement.right - placement.left) };

function layoutStack(
  list: HTMLElement,
  items: HTMLElement[],
  heights: number[],
  expanded: boolean,
  bare: boolean,
) {
  if (expanded || items.length <= 1) {
    let y = 0;
    items.forEach((item, index) => {
      item.removeAttribute("data-peek");
      item.style.height = "";
      item.style.translate = `0 ${y}px`;
      item.style.scale = "1";
      item.style.zIndex = String(items.length - index);
      item.style.setProperty("--notice-opacity", "1");
      y += heights[index] + NOTICE_GAP_PX;
    });
    list.style.height = `${Math.max(0, y - NOTICE_GAP_PX)}px`;
    return;
  }
  const top = heights[0];
  items.forEach((item, index) => {
    const depth = Math.min(index, MAX_PEEKS);
    if (index === 0) {
      item.removeAttribute("data-peek");
      item.style.height = "";
    } else {
      item.setAttribute("data-peek", "");
      item.style.height = `${top}px`;
    }
    item.style.translate = `0 ${bare ? 0 : depth * PEEK_STEP_PX}px`;
    item.style.scale = `${1 - depth * PEEK_SHRINK} 1`;
    item.style.zIndex = String(items.length - index);
    item.style.setProperty(
      "--notice-opacity",
      index === 0 ? "1" : index <= MAX_PEEKS && !bare ? String(PEEK_OPACITY[index - 1]) : "0",
    );
  });
  list.style.height = `${top + (bare ? 0 : Math.min(MAX_PEEKS, items.length - 1) * PEEK_STEP_PX)}px`;
}

function collectObstacles(
  slot: HTMLElement,
  slotRect: DOMRect,
  root: Element | null,
) {
  const obstacles: LaneObstacle[] = [];
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

function fullScreenPanel() {
  const probe = document.elementFromPoint(window.innerWidth / 2, 1);
  const panel = probe?.closest(".fixed") ?? null;
  const header = panel?.firstElementChild ?? null;
  return { panel, headerBottom: header ? header.getBoundingClientRect().bottom : 60 };
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
  const fullHeightsRef = useRef(new WeakMap<Element, { key: string; height: number }>());
  const fullListHeightRef = useRef<{ key: string; height: number } | null>(null);
  const [lane, setLane] = useState<LaneState>({ compact: false, offset: 0, count: 0, room: 0 });
  const [expanded, setExpanded] = useState(false);
  const [announcements, setAnnouncements] = useState<
    ReadonlyMap<string, { text: string; urgent: boolean }>
  >(() => new Map());
  const laneRef = useRef(lane);
  laneRef.current = lane;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const overPanelRef = useRef(overPanel);
  overPanelRef.current = overPanel;
  const [panelTarget, setPanelTarget] = useState<HTMLElement | null>(null);
  const panelTargetRef = useRef(panelTarget);
  panelTargetRef.current = panelTarget;
  const scheduleRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    if (!overPanel) {
      setPanelTarget(null);
      return;
    }
    const findTarget = () => {
      const targets = document.querySelectorAll<HTMLElement>("[data-panel-notices]");
      setPanelTarget(targets[targets.length - 1] ?? null);
    };
    findTarget();
    const panels = new MutationObserver(findTarget);
    panels.observe(document.body, { childList: true, subtree: true });
    return () => panels.disconnect();
  }, [overPanel]);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    const column = columnRef.current;
    const row = rowRef.current;
    const list = listRef.current;
    if (!slot || !column || !row || !list) return;

    const commit = (next: LaneState) => {
      if (next.count <= 1) setExpanded(false);
      setLane((prev) => (sameLane(prev, next) ? prev : next));
    };

    const measure = () => {
      const items = [...list.children] as HTMLElement[];
      const count = items.length;
      if (count === 0) {
        list.style.height = "0px";
        commit({ compact: false, offset: 0, count: 0, room: 0 });
        return;
      }
      for (const item of items) item.style.height = "";
      const heights = items.map((item) => item.offsetHeight);
      const isExpanded = expandedRef.current && count > 1;
      layoutStack(list, items, heights, isExpanded, Boolean(laneRef.current.bare));

      const peekSpace = Math.min(MAX_PEEKS, count - 1) * PEEK_STEP_PX;
      const footerSpace = count > 1 ? TOGGLE_HEIGHT_PX : 0;
      const listHeight =
        heights.reduce((sum, height) => sum + height, 0) + NOTICE_GAP_PX * (count - 1);
      const slotRect = slot.getBoundingClientRect();
      const cssMinTop = parseFloat(getComputedStyle(column).paddingTop) || 0;
      const maxBottom = column.clientHeight;

      const target = panelTargetRef.current;
      if (target) {
        const panelRect = (target.closest(".fixed") ?? target.parentElement ?? target).getBoundingClientRect();
        const listTop = list.getBoundingClientRect().top;
        const panelRoom = Math.min(
          panelRect.bottom - listTop - TOGGLE_HEIGHT_PX - NOTICE_GAP_PX,
          panelRect.height * PANEL_NOTICE_SHARE - TOGGLE_HEIGHT_PX,
        );
        commit({
          compact: !isExpanded,
          offset: 0,
          count,
          room: Math.max(COMPACT_HEIGHT_PX, Math.floor(panelRoom)),
        });
        return;
      }

      const columnStyle = getComputedStyle(column);
      const padLeft = parseFloat(columnStyle.paddingLeft) || 0;
      const contentWidth =
        column.clientWidth - padLeft - (parseFloat(columnStyle.paddingRight) || 0);
      const laneWidth = Math.min(MAX_LANE_WIDTH_PX, contentWidth);
      const laneLeft = column.getBoundingClientRect().left - slotRect.left + padLeft + (contentWidth - laneWidth) / 2;
      const bounds = {
        left: laneLeft,
        right: laneLeft + laneWidth,
        minTop: cssMinTop,
        maxBottom,
      };
      if (overPanelRef.current) {
        const { panel, headerBottom } = fullScreenPanel();
        const placement = placeNoticeLane(collectObstacles(slot, slotRect, panel), {
          ...bounds,
          minTop: Math.max(cssMinTop, headerBottom - slotRect.top + NOTICE_GAP_PX),
          count: 1,
          fullHeight: Number.POSITIVE_INFINITY,
          collapsedHeight: Number.POSITIVE_INFINITY,
          compactHeight: COMPACT_HEIGHT_PX + peekSpace,
        });
        commit({
          compact: true,
          offset: Math.max(0, placement.top - cssMinTop),
          count,
          room: maxBottom - placement.top,
        });
        return;
      }

      const obstacles = collectObstacles(slot, slotRect, slot.parentElement);
      if (isExpanded) {
        const listContent = items
          .map((item) => item.querySelector("[data-notice-content]")?.getAttribute("data-notice-content") ?? "")
          .join("|");
        const crampedNow = Boolean(laneRef.current.cramped);
        if (!crampedNow) {
          fullListHeightRef.current = {
            key: `${Math.round(row.clientWidth)}:${listContent}`,
            height: listHeight,
          };
        } else if (fullListHeightRef.current?.key !== `${Math.round(laneWidth)}:${listContent}`) {
          commit({ ...laneRef.current, cramped: false, narrow: undefined, count });
          return;
        }
        const desired = (fullListHeightRef.current?.height ?? listHeight) + TOGGLE_HEIGHT_PX;
        const gap = findLaneGap(
          obstacles,
          bounds,
          desired,
          Math.min(desired, COMPACT_HEIGHT_PX + TOGGLE_HEIGHT_PX),
        );
        const fallback = gap
          ? null
          : placeNoticeLane(obstacles, {
              ...bounds,
              count: 1,
              fullHeight: Number.POSITIVE_INFINITY,
              collapsedHeight: Number.POSITIVE_INFINITY,
              compactHeight: COMPACT_HEIGHT_PX + TOGGLE_HEIGHT_PX,
            });
        const top = gap ? gap.top : (fallback?.top ?? cssMinTop);
        const height = gap ? Math.min(gap.height, desired) : COMPACT_HEIGHT_PX + TOGGLE_HEIGHT_PX;
        commit({
          compact: false,
          offset: Math.max(0, top - cssMinTop),
          count,
          room: Math.max(COMPACT_HEIGHT_PX, height - TOGGLE_HEIGHT_PX),
          narrow: fallback ? narrowLane(fallback, padLeft) : undefined,
          cramped: !gap || gap.height < desired,
        });
        return;
      }

      const compactNow = laneRef.current.compact;
      const topContent =
        items[0].querySelector("[data-notice-content]")?.getAttribute("data-notice-content") ?? "";
      let topFullHeight = heights[0];
      if (compactNow) {
        const cached = fullHeightsRef.current.get(items[0]);
        if (!cached || cached.key !== `${Math.round(laneWidth)}:${topContent}`) {
          commit({ ...laneRef.current, compact: false, narrow: undefined, bare: false, count });
          return;
        }
        topFullHeight = cached.height;
      } else {
        fullHeightsRef.current.set(items[0], {
          key: `${Math.round(row.clientWidth)}:${topContent}`,
          height: heights[0],
        });
      }
      const placement = placeNoticeLane(obstacles, {
        ...bounds,
        count: 1,
        fullHeight: topFullHeight + peekSpace + footerSpace,
        collapsedHeight: Number.POSITIVE_INFINITY,
        compactHeight: COMPACT_HEIGHT_PX + peekSpace,
      });
      commit({
        compact: placement.mode !== "full",
        offset: Math.max(0, placement.top - cssMinTop),
        count,
        room: maxBottom - placement.top,
        narrow: narrowLane(placement, padLeft),
        bare: Boolean(placement.blocked),
      });
    };

    let frame = 0;
    let lastPointerMeasure = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const scheduleFromPointer = () => {
      const now = performance.now();
      if (list.children.length === 0 || now - lastPointerMeasure < POINTER_REMEASURE_MS) return;
      lastPointerMeasure = now;
      schedule();
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
    const revealEvents = ["transitionend", "animationend"] as const;
    if (stage) {
      stageMutations.observe(stage, { childList: true, subtree: true });
      stage.addEventListener("pointermove", scheduleFromPointer, { passive: true });
      stage.addEventListener("scroll", schedule, { passive: true, capture: true });
      for (const type of revealEvents) {
        stage.addEventListener(type, schedule, { passive: true });
      }
    }
    const interval = window.setInterval(() => {
      if (list.children.length > 0) schedule();
    }, REMEASURE_INTERVAL_MS);
    scheduleRef.current = schedule;
    observeNotices();
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(interval);
      listMutations.disconnect();
      stageMutations.disconnect();
      stage?.removeEventListener("pointermove", scheduleFromPointer);
      stage?.removeEventListener("scroll", schedule, { capture: true });
      for (const type of revealEvents) stage?.removeEventListener(type, schedule);
      resizes.disconnect();
    };
  }, [panelTarget]);

  useLayoutEffect(() => {
    scheduleRef.current();
  }, [expanded, lane.compact, lane.bare, lane.cramped]);

  const announce = useCallback((id: string, text: string | null, urgent: boolean) => {
    setAnnouncements((prev) => {
      const current = prev.get(id);
      if (text === null ? !current : current?.text === text && current.urgent === urgent) {
        return prev;
      }
      const next = new Map(prev);
      if (text === null) next.delete(id);
      else next.set(id, { text, urgent });
      return next;
    });
  }, []);

  const isExpanded = expanded && lane.count > 1;
  const compact = isExpanded ? Boolean(lane.cramped) : lane.compact;
  const laneContext = useMemo(
    () => ({ compact, expanded: isExpanded, announce }),
    [compact, isExpanded, announce],
  );
  const toggleExpanded = () => setExpanded((value) => !value);
  const more = lane.count - 1;
  const expandFromPeek = (event: { target: EventTarget }) => {
    if (!isExpanded && more > 0 && (event.target as Element).closest("[data-peek]")) {
      setExpanded(true);
    }
  };

  const inlineCount = more > 0 && compact && !isExpanded;
  const footer =
    more > 0 && !inlineCount ? (
      <button
        type="button"
        onClick={toggleExpanded}
        aria-expanded={isExpanded}
        aria-label={isExpanded ? "Collapse notices" : `Show ${more} more notices`}
        className="pointer-events-auto mt-2 inline-flex h-7 shrink-0 items-center rounded-full px-3 text-[12px] font-medium text-[#fafafa]/60 transition-colors duration-100 hover:text-[#fafafa]"
      >
        {isExpanded ? "Show less" : `+${more} more`}
      </button>
    ) : null;

  const laneContent = (
    <>
      <div
        ref={rowRef}
        className="relative flex w-full max-w-[560px] items-start gap-1"
        style={
          lane.narrow
            ? {
                marginTop: lane.offset,
                alignSelf: "flex-start",
                marginLeft: lane.narrow.left,
                width: lane.narrow.width,
              }
            : { marginTop: lane.offset }
        }
      >
        <div
          ref={listRef}
          onClick={expandFromPeek}
          className="relative min-w-0 flex-1 overscroll-contain [&>*]:absolute [&>*]:inset-x-0 [&>*]:top-0 [&>*]:origin-top [&>*]:transition-[translate,scale] [&>*]:duration-[120ms] [&>*]:ease-out motion-reduce:[&>*]:transition-none [&>[data-peek]]:cursor-pointer [&>[data-peek]_[data-in-call-notice]>*]:invisible"
          style={
            isExpanded && lane.room > 0
              ? { maxHeight: lane.room, overflowY: "auto" }
              : undefined
          }
        >
          {children}
        </div>
        {inlineCount ? (
          <button
            type="button"
            onClick={toggleExpanded}
            aria-expanded={false}
            aria-label={`Show ${more} more notices`}
            className="pointer-events-auto inline-flex h-11 shrink-0 items-center rounded-xl px-2 text-[12px] font-medium tabular-nums text-[#fafafa]/60 transition-colors duration-100 hover:text-[#fafafa]"
          >
            +{more}
          </button>
        ) : null}
      </div>
      {footer}
    </>
  );

  return (
    <InCallNoticeLaneContext.Provider value={laneContext}>
      {panelTarget
        ? createPortal(
            <div className="flex w-full flex-col items-center">{laneContent}</div>,
            panelTarget,
          )
        : null}
      <div
        ref={slotRef}
        data-in-call-notices
        data-lane-mode={lane.count > 0 ? (isExpanded ? "expanded" : compact ? "compact" : lane.count > 1 ? "stack" : "full") : undefined}
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
          {panelTarget ? null : laneContent}
        </div>
        <div aria-live="polite" className="sr-only">
          {[...announcements].map(([id, { text, urgent }]) =>
            urgent ? null : <p key={id}>{text}</p>,
          )}
        </div>
        <div role="alert" className="sr-only">
          {[...announcements].map(([id, { text, urgent }]) =>
            urgent ? <p key={id}>{text}</p> : null,
          )}
        </div>
      </div>
    </InCallNoticeLaneContext.Provider>
  );
}
