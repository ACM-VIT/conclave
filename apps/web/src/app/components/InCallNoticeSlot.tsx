"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Bell, X } from "lucide-react";
import {
  findClearSpot,
  InCallNoticeLaneContext,
  placeNoticeLane,
  placeNoticeList,
  type LaneObstacle,
} from "../lib/in-call-notice-lane";

const NOTICE_GAP_PX = 8;
const TOGGLE_HEIGHT_PX = 36;
const COMPACT_HEIGHT_PX = 44;
const LIST_MIN_HEIGHT_PX = 2 * COMPACT_HEIGHT_PX + NOTICE_GAP_PX;
const CHIP_HEIGHT_PX = 40;
const CHIP_WIDTH_PX = 56;
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

type NoticeView = "stack" | "list" | "sheet";

interface Announcement {
  text: string;
  urgent: boolean;
  holders: number;
}

interface LaneState {
  compact: boolean;
  offset: number;
  count: number;
  room: number;
  narrow?: { left: number; width: number };
  cramped?: boolean;
  probing?: boolean;
  chip?: { left: number; top: number; urgent: boolean };
}

const EMPTY_LANE: LaneState = { compact: false, offset: 0, count: 0, room: 0 };

const sameLane = (a: LaneState, b: LaneState) =>
  a.compact === b.compact &&
  a.offset === b.offset &&
  a.count === b.count &&
  a.room === b.room &&
  a.narrow?.left === b.narrow?.left &&
  a.narrow?.width === b.narrow?.width &&
  a.cramped === b.cramped &&
  a.probing === b.probing &&
  a.chip?.left === b.chip?.left &&
  a.chip?.top === b.chip?.top &&
  a.chip?.urgent === b.chip?.urgent;

const narrowLane = (
  placement: { left?: number; right?: number },
  padLeft: number,
): LaneState["narrow"] =>
  placement.left === undefined || placement.right === undefined
    ? undefined
    : { left: Math.round(placement.left - padLeft), width: Math.round(placement.right - placement.left) };

const noticeContent = (item: Element) =>
  item.querySelector("[data-notice-content]")?.getAttribute("data-notice-content") ?? "";

function layoutStack(list: HTMLElement, items: HTMLElement[], heights: number[], expanded: boolean) {
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
    item.style.translate = `0 ${depth * PEEK_STEP_PX}px`;
    item.style.scale = `${1 - depth * PEEK_SHRINK} 1`;
    item.style.zIndex = String(items.length - index);
    item.style.setProperty(
      "--notice-opacity",
      index === 0 ? "1" : index <= MAX_PEEKS ? String(PEEK_OPACITY[index - 1]) : "0",
    );
  });
  list.style.height = `${top + Math.min(MAX_PEEKS, items.length - 1) * PEEK_STEP_PX}px`;
}

function collectObstacles(slot: HTMLElement, slotRect: DOMRect, root: Element | null) {
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

function heightKeptBelow(target: Element) {
  let kept = 0;
  for (let sibling = target.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
    const style = getComputedStyle(sibling);
    if (style.display === "none" || style.position === "absolute" || style.position === "fixed") continue;
    const shrinksToContent =
      style.minHeight === "auto" && style.overflowX === "visible" && style.overflowY === "visible";
    const frame = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"] as const;
    const minimum =
      style.flexShrink === "0" || shrinksToContent
        ? (sibling as HTMLElement).offsetHeight
        : Math.max(
            parseFloat(style.minHeight) || 0,
            frame.reduce((sum, side) => sum + (parseFloat(style[side]) || 0), 0),
          );
    kept += minimum + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
  }
  return kept;
}

function panelRoom(target: HTMLElement) {
  const panel = target.closest(".fixed") ?? target.parentElement ?? target;
  const panelRect = panel.getBoundingClientRect();
  const top = target.offsetParent
    ? target.getBoundingClientRect().top
    : (target.previousElementSibling?.getBoundingClientRect().bottom ?? panelRect.top);
  const padTop = parseFloat(getComputedStyle(target).paddingTop) || 0;
  return {
    panel,
    top,
    height: panelRect.height,
    room: Math.floor(Math.min(panelRect.bottom, window.innerHeight) - top - padTop - heightKeptBelow(target)),
  };
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
  const sheetRef = useRef<HTMLDialogElement>(null);
  const fullHeightsRef = useRef(new WeakMap<Element, { key: string; height: number }>());
  const fullListHeightRef = useRef<{ key: string; height: number } | null>(null);
  const [lane, setLane] = useState<LaneState>(EMPTY_LANE);
  const [view, setView] = useState<NoticeView>("stack");
  const [announcements, setAnnouncements] = useState<ReadonlyMap<string, Announcement>>(
    () => new Map(),
  );
  const [panelTarget, setPanelTarget] = useState<HTMLElement | null>(null);
  const [sheetBody, setSheetBody] = useState<HTMLDivElement | null>(null);
  const laneRef = useRef(lane);
  laneRef.current = lane;
  const viewRef = useRef(view);
  viewRef.current = view;
  const overPanelRef = useRef(overPanel);
  overPanelRef.current = overPanel;
  const panelTargetRef = useRef(panelTarget);
  panelTargetRef.current = panelTarget;
  const scheduleRef = useRef<() => void>(() => {});
  const surface =
    view === "sheet" && sheetBody ? sheetBody : panelTarget && !lane.chip ? panelTarget : null;

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
    const sheet = sheetRef.current;
    if (view === "sheet" && sheet && !sheet.open) sheet.showModal?.();
  }, [view]);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    const column = columnRef.current;
    const row = rowRef.current;
    const list = listRef.current;
    if (!slot || !column || !row || !list) return;

    const commit = (next: LaneState) => {
      if (next.count === 0) setView("stack");
      else if (next.count === 1) setView((current) => (current === "list" ? "stack" : current));
      setLane((prev) => (sameLane(prev, next) ? prev : next));
    };
    const openSheet = () => setView("sheet");

    const measure = () => {
      const items = [...list.children] as HTMLElement[];
      const count = items.length;
      if (count === 0) {
        list.style.height = "0px";
        commit(EMPTY_LANE);
        return;
      }
      for (const item of items) item.style.height = "";
      const heights = items.map((item) => item.offsetHeight);
      const currentView = viewRef.current;
      const showsList = currentView === "sheet" || (currentView === "list" && count > 1);
      layoutStack(list, items, heights, showsList);
      if (currentView === "sheet") {
        commit({ compact: false, offset: 0, count, room: 0 });
        return;
      }

      const peekSpace = Math.min(MAX_PEEKS, count - 1) * PEEK_STEP_PX;
      const footerSpace = count > 1 ? TOGGLE_HEIGHT_PX : 0;
      const listHeight =
        heights.reduce((sum, height) => sum + height, 0) + NOTICE_GAP_PX * (count - 1);

      const urgent = items.some((item) => item.querySelector('[data-tone="error"]'));
      const slotRect = slot.getBoundingClientRect();
      const listContent = items.map(noticeContent).join("|");
      const fullListHeight = (naturalWidth: number) => {
        if (!laneRef.current.cramped) {
          fullListHeightRef.current = {
            key: `${Math.round(row.clientWidth)}:${listContent}`,
            height: listHeight,
          };
          return listHeight;
        }
        const cached = fullListHeightRef.current;
        return cached?.key === `${Math.round(naturalWidth)}:${listContent}` ? cached.height : null;
      };
      const probeFullList = () =>
        commit({ ...laneRef.current, cramped: false, narrow: undefined, probing: true, count });

      const target = panelTargetRef.current;
      if (target) {
        const inPanel = panelRoom(target);
        if (showsList) {
          const full = fullListHeight(row.clientWidth);
          if (full === null) {
            probeFullList();
            return;
          }
          const room = Math.min(
            inPanel.room - TOGGLE_HEIGHT_PX - NOTICE_GAP_PX,
            Math.floor(inPanel.height * PANEL_NOTICE_SHARE) - TOGGLE_HEIGHT_PX,
          );
          if (room < Math.min(full, LIST_MIN_HEIGHT_PX)) openSheet();
          else commit({ compact: false, offset: 0, count, room, cramped: room < full });
          return;
        }
        if (inPanel.room >= COMPACT_HEIGHT_PX + peekSpace) {
          commit({ compact: true, offset: 0, count, room: 0 });
          return;
        }
        const chipBounds = {
          left: NOTICE_GAP_PX,
          right: slotRect.width - NOTICE_GAP_PX,
          minTop: inPanel.top - slotRect.top,
          maxBottom: slotRect.height,
        };
        const obstacles = collectObstacles(slot, slotRect, inPanel.panel);
        const spot = findClearSpot(obstacles, chipBounds, CHIP_WIDTH_PX, CHIP_HEIGHT_PX) ?? {
          left: chipBounds.left,
          top: chipBounds.minTop,
        };
        commit({
          compact: true,
          offset: 0,
          count,
          room: 0,
          chip: { left: Math.round(spot.left), top: Math.round(spot.top), urgent },
        });
        return;
      }

      const columnStyle = getComputedStyle(column);
      const cssMinTop = parseFloat(columnStyle.paddingTop) || 0;
      const padLeft = parseFloat(columnStyle.paddingLeft) || 0;
      const contentWidth = column.clientWidth - padLeft - (parseFloat(columnStyle.paddingRight) || 0);
      const contentLeft = column.getBoundingClientRect().left - slotRect.left + padLeft;
      const laneWidth = Math.min(MAX_LANE_WIDTH_PX, contentWidth);
      const laneLeft = contentLeft + (contentWidth - laneWidth) / 2;
      const coversPanel = overPanelRef.current;
      const { panel, headerBottom } = coversPanel ? fullScreenPanel() : { panel: null, headerBottom: 0 };
      const minTop = coversPanel
        ? Math.max(cssMinTop, headerBottom - slotRect.top + NOTICE_GAP_PX)
        : cssMinTop;
      const bounds = { left: laneLeft, right: laneLeft + laneWidth, minTop, maxBottom: column.clientHeight };
      const obstacles = collectObstacles(slot, slotRect, coversPanel ? panel : slot.parentElement);

      if (showsList) {
        const full = fullListHeight(laneWidth);
        if (full === null) {
          probeFullList();
          return;
        }
        const desired = full + TOGGLE_HEIGHT_PX;
        const spot = placeNoticeList(
          obstacles,
          bounds,
          desired,
          Math.min(desired, LIST_MIN_HEIGHT_PX + TOGGLE_HEIGHT_PX),
        );
        if (!spot) {
          openSheet();
          return;
        }
        const height = Math.min(spot.height, desired);
        commit({
          compact: false,
          offset: Math.max(0, spot.top - cssMinTop),
          count,
          room: height - TOGGLE_HEIGHT_PX,
          narrow: narrowLane(spot, padLeft),
          cramped: height < desired,
        });
        return;
      }

      const topContent = noticeContent(items[0]);
      let topFullHeight = heights[0];
      if (laneRef.current.compact) {
        const cached = fullHeightsRef.current.get(items[0]);
        if (!cached || cached.key !== `${Math.round(laneWidth)}:${topContent}`) {
          commit({ ...laneRef.current, compact: false, narrow: undefined, probing: true, count });
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
        fullHeight: coversPanel ? Number.POSITIVE_INFINITY : topFullHeight + peekSpace + footerSpace,
        compactHeight: COMPACT_HEIGHT_PX + peekSpace,
      });
      if (!placement) {
        const chipBounds = { ...bounds, left: contentLeft, right: contentLeft + contentWidth };
        const spot =
          findClearSpot(obstacles, chipBounds, CHIP_WIDTH_PX, CHIP_HEIGHT_PX) ??
          { left: contentLeft, top: minTop };
        commit({
          compact: true,
          offset: 0,
          count,
          room: 0,
          chip: { left: Math.round(spot.left), top: Math.round(spot.top), urgent },
        });
        return;
      }
      commit({
        compact: placement.mode !== "full",
        offset: Math.max(0, placement.top - cssMinTop),
        count,
        room: bounds.maxBottom - placement.top,
        narrow: narrowLane(placement, padLeft),
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
  }, [surface]);

  const chipShown = Boolean(lane.chip);
  useLayoutEffect(() => {
    scheduleRef.current();
  }, [view, lane.compact, lane.cramped, lane.probing, chipShown, panelTarget]);

  const announce = useCallback((text: string, urgent: boolean) => {
    const key = `${urgent ? "alert" : "status"}:${text}`;
    const holders = (delta: number) =>
      setAnnouncements((prev) =>
        new Map(prev).set(key, { text, urgent, holders: (prev.get(key)?.holders ?? 0) + delta }),
      );
    holders(1);
    return () => holders(-1);
  }, []);

  useEffect(() => {
    if ([...announcements.values()].every((entry) => entry.holders > 0)) return;
    setAnnouncements((prev) => new Map([...prev].filter(([, entry]) => entry.holders > 0)));
  }, [announcements]);
  const spoken = [...announcements].filter(([, entry]) => entry.holders > 0);

  const inSheet = view === "sheet";
  const isExpanded = inSheet || (view === "list" && lane.count > 1);
  const compact = inSheet ? false : isExpanded ? Boolean(lane.cramped) : lane.compact;
  const laneContext = useMemo(
    () => ({ compact, expanded: isExpanded, announce }),
    [compact, isExpanded, announce],
  );
  const toggleExpanded = () => setView((current) => (current === "stack" ? "list" : "stack"));
  const more = lane.count - 1;
  const chip = inSheet ? undefined : lane.chip;
  const expandFromPeek = (event: { target: EventTarget }) => {
    if (!isExpanded && more > 0 && (event.target as Element).closest("[data-peek]")) {
      setView("list");
    }
  };

  const inlineCount = more > 0 && compact && !isExpanded && !chip;
  const footer =
    more > 0 && !inlineCount && !inSheet && !chip ? (
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
        inert={chip ? true : undefined}
        className={`${chip ? "invisible absolute" : lane.probing ? "invisible relative" : "relative"} flex w-full max-w-[560px] items-start gap-1`}
        style={
          lane.narrow && !inSheet
            ? {
                marginTop: lane.offset,
                alignSelf: "flex-start",
                marginLeft: lane.narrow.left,
                width: lane.narrow.width,
              }
            : { marginTop: inSheet ? 0 : lane.offset }
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

  const ChipIcon = chip?.urgent ? AlertCircle : Bell;

  return (
    <InCallNoticeLaneContext.Provider value={laneContext}>
      {surface
        ? createPortal(
            <div className="flex w-full flex-col items-center">{laneContent}</div>,
            surface,
          )
        : null}
      <div
        ref={slotRef}
        data-in-call-notices
        data-lane-mode={
          lane.count > 0
            ? inSheet
              ? "sheet"
              : chip
                ? "chip"
                : isExpanded
                  ? "expanded"
                  : compact
                    ? "compact"
                    : lane.count > 1
                      ? "stack"
                      : "full"
            : undefined
        }
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
          {surface ? null : laneContent}
        </div>
        {chip ? (
          <button
            type="button"
            onClick={() => setView("sheet")}
            aria-label={lane.count === 1 ? "Show notice" : `Show ${lane.count} notices`}
            className="pointer-events-auto absolute inline-flex h-10 items-center justify-center gap-1.5 rounded-full border border-[#fafafa]/10 bg-[#232327] px-3 text-[12px] font-medium tabular-nums text-[#fafafa] transition-colors duration-100 hover:bg-[#2a2a2f]"
            style={{ left: chip.left, top: chip.top, minWidth: CHIP_HEIGHT_PX }}
          >
            <ChipIcon
              size={18}
              strokeWidth={1.75}
              className={chip.urgent ? "text-[#F95F4A]" : "text-[#fafafa]"}
            />
            {lane.count > 1 ? lane.count : null}
          </button>
        ) : null}
        {inSheet ? (
          <dialog
            ref={sheetRef}
            aria-label="Notices"
            onClose={() => setView((current) => (current === "sheet" ? "stack" : current))}
            onClick={(event) => {
              if (event.target === event.currentTarget) event.currentTarget.close();
            }}
            className="pointer-events-auto m-auto mb-[calc(env(safe-area-inset-bottom,0px)+12px)] max-h-[min(80dvh,640px)] w-[min(560px,calc(100vw-24px))] max-w-none flex-col overflow-hidden rounded-2xl border border-[#fafafa]/10 bg-[#18181b] p-0 text-[#fafafa] backdrop:bg-black/50 open:flex motion-safe:open:animate-[acm-fade-in_120ms_ease-out_both]"
          >
            <div className="flex shrink-0 items-center justify-between py-2 pl-4 pr-2">
              <h2 className="text-[13.5px] font-medium">Notices</h2>
              <button
                type="button"
                aria-label="Close notices"
                onClick={() => sheetRef.current?.close()}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[#fafafa]/55 transition-colors duration-100 hover:bg-[#fafafa]/[0.06] hover:text-[#fafafa]"
              >
                <X size={18} strokeWidth={1.75} />
              </button>
            </div>
            <div ref={setSheetBody} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3" />
          </dialog>
        ) : null}
        <div aria-live="polite" className="sr-only">
          {spoken.map(([key, { text, urgent }]) => (urgent ? null : <p key={key}>{text}</p>))}
        </div>
        <div role="alert" className="sr-only">
          {spoken.map(([key, { text, urgent }]) => (urgent ? <p key={key}>{text}</p> : null))}
        </div>
      </div>
    </InCallNoticeLaneContext.Provider>
  );
}
