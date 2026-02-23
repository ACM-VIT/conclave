"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { JoinMode } from "../lib/types";
import { generateSessionId } from "../lib/utils";

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const parseNumberInput = (
  value: string,
  fallback: number,
  min: number,
  max: number,
) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return clampNumber(parsed, min, max);
};

const clientId = process.env.NEXT_PUBLIC_SFU_CLIENT_ID || "public";

const readError = async (response: Response) => {
  const data = await response.json().catch(() => null);
  if (data && typeof data === "object" && "error" in data) {
    return String((data as { error?: string }).error || "Request failed");
  }
  return response.statusText || "Request failed";
};

interface DevMeetToolsPanelProps {
  roomId: string;
}

type SpawnMethod = "inline" | "popup" | "headless";
type InlineBot = {
  id: string;
  name: string;
  url: string;
};

export default function DevMeetToolsPanel({ roomId }: DevMeetToolsPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [spawnCount, setSpawnCount] = useState(3);
  const [namePrefix, setNamePrefix] = useState("Dev");
  const [nextIndex, setNextIndex] = useState(1);
  const [joinMode, setJoinMode] = useState<JoinMode>("meeting");
  const [autoJoin, setAutoJoin] = useState(true);
  const [hideJoinUI, setHideJoinUI] = useState(true);
  const [bypassMedia, setBypassMedia] = useState(true);
  const [spawnDelayMs, setSpawnDelayMs] = useState(150);
  const [autoCloseSeconds, setAutoCloseSeconds] = useState(0);
  const [asAdmin, setAsAdmin] = useState(false);
  const [openWindowsCount, setOpenWindowsCount] = useState(0);
  const [spawnMethod, setSpawnMethod] = useState<SpawnMethod>("headless");
  const [inlineBots, setInlineBots] = useState<InlineBot[]>([]);
  const [headlessCount, setHeadlessCount] = useState(0);
  const openWindowsRef = useRef<Window[]>([]);
  const headlessSocketsRef = useRef<Map<string, Socket>>(new Map());
  const headlessTimersRef = useRef<Map<string, number>>(new Map());

  const canSpawn = roomId.trim().length > 0;

  const buildSpawnUrl = useCallback(
    (displayName: string, sessionId?: string) => {
      const shouldHideJoinUI = hideJoinUI && autoJoin;
      const safeRoomId = encodeURIComponent(roomId.trim());
      const url = new URL(`/${safeRoomId}`, window.location.origin);
      if (autoJoin) url.searchParams.set("autojoin", "1");
      if (shouldHideJoinUI) url.searchParams.set("hide", "1");
      if (bypassMedia) url.searchParams.set("recorder", "1");
      if (asAdmin) url.searchParams.set("admin", "1");
      if (joinMode === "webinar_attendee") {
        url.searchParams.set("mode", "webinar_attendee");
      }
      if (sessionId) {
        url.searchParams.set("session", sessionId);
      }
      if (displayName.trim()) {
        url.searchParams.set("name", displayName.trim());
      }
      return url.toString();
    },
    [roomId, autoJoin, hideJoinUI, bypassMedia, asAdmin, joinMode],
  );

  const removeInlineBot = useCallback((id: string) => {
    setInlineBots((prev) => prev.filter((bot) => bot.id !== id));
  }, []);

  const removeHeadlessBot = useCallback(
    (id: string, disconnect = true) => {
      const socket = headlessSocketsRef.current.get(id);
      if (socket) {
        socket.removeAllListeners();
        if (disconnect && socket.connected) {
          socket.disconnect();
        }
      }
      headlessSocketsRef.current.delete(id);
      const timer = headlessTimersRef.current.get(id);
      if (timer) {
        window.clearTimeout(timer);
        headlessTimersRef.current.delete(id);
      }
      setHeadlessCount(headlessSocketsRef.current.size);
    },
    [],
  );

  const registerHeadlessBot = useCallback(
    (id: string, socket: Socket, autoCloseMs: number) => {
      headlessSocketsRef.current.set(id, socket);
      setHeadlessCount(headlessSocketsRef.current.size);
      socket.on("disconnect", () => removeHeadlessBot(id, false));
      if (autoCloseMs > 0) {
        const timer = window.setTimeout(() => {
          removeHeadlessBot(id);
        }, autoCloseMs);
        headlessTimersRef.current.set(id, timer);
      }
    },
    [removeHeadlessBot],
  );

  const createHeadlessBot = useCallback(
    async (label: string, sessionId: string, autoCloseMs: number) => {
      const targetRoomId = roomId.trim();
      if (!targetRoomId) return;
      const botId = `devbot-${sessionId}`;
      const response = await fetch("/api/sfu/join", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-sfu-client": clientId,
        },
        body: JSON.stringify({
          roomId: targetRoomId,
          sessionId,
          user: {
            id: botId,
            name: label,
          },
          isHost: asAdmin,
          allowRoomCreation: false,
          clientId,
          joinMode,
        }),
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const data = (await response.json()) as {
        token: string;
        sfuUrl: string;
      };
      const { io } = await import("socket.io-client");
      const socket = io(data.sfuUrl, {
        transports: ["websocket", "polling"],
        timeout: 10000,
        reconnection: false,
        forceNew: true,
        auth: { token: data.token },
      });

      registerHeadlessBot(botId, socket, autoCloseMs);

      socket.on("connect", () => {
        socket.emit(
          "joinRoom",
          {
            roomId: targetRoomId,
            sessionId,
          },
          (joinResponse: { error?: string }) => {
            if (joinResponse?.error) {
              console.warn("[DevBots] Join error:", joinResponse.error);
              removeHeadlessBot(botId);
            }
          },
        );
      });

      socket.on("connect_error", (err) => {
        console.warn("[DevBots] Socket error:", err);
        removeHeadlessBot(botId);
      });
    },
    [asAdmin, joinMode, registerHeadlessBot, removeHeadlessBot, roomId],
  );

  const registerWindow = useCallback(
    (handle: Window | null, autoCloseMs: number) => {
      if (!handle) return;
      openWindowsRef.current.push(handle);
      setOpenWindowsCount((prev) => prev + 1);
      if (autoCloseMs > 0) {
        window.setTimeout(() => {
          try {
            if (!handle.closed) {
              handle.close();
            }
          } catch {
            // Ignore close failures (popup blockers or navigation changes).
          }
          setOpenWindowsCount((prev) => Math.max(0, prev - 1));
        }, autoCloseMs);
      }
    },
    [],
  );

  const spawnParticipants = useCallback(() => {
    if (!canSpawn || typeof window === "undefined") return;
    const count = clampNumber(spawnCount, 1, 50);
    const delay = clampNumber(spawnDelayMs, 0, 5000);
    const autoCloseMs = clampNumber(autoCloseSeconds, 0, 3600) * 1000;
    const baseIndex = Math.max(1, nextIndex);
    const width = 380;
    const height = 700;
    const gap = 18;
    const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
    const baseLeft = window.screenX + 40;
    const baseTop = window.screenY + 60;

    if (spawnMethod === "inline") {
      const newBots: InlineBot[] = [];
      for (let i = 0; i < count; i += 1) {
        const label = `${namePrefix || "Dev"} ${baseIndex + i}`.trim();
        const sessionId = generateSessionId();
        const url = buildSpawnUrl(label, sessionId);
        const id = `inline-${sessionId}`;
        newBots.push({ id, name: label, url });
        if (autoCloseMs > 0) {
          window.setTimeout(() => removeInlineBot(id), autoCloseMs);
        }
      }
      setInlineBots((prev) => [...prev, ...newBots]);
      setNextIndex(baseIndex + count);
      return;
    }

    if (spawnMethod === "headless") {
      for (let i = 0; i < count; i += 1) {
        const label = `${namePrefix || "Dev"} ${baseIndex + i}`.trim();
        const sessionId = generateSessionId();
        const startBot = () => {
          void createHeadlessBot(label, sessionId, autoCloseMs).catch((err) =>
            console.warn("[DevBots] Failed to spawn bot:", err),
          );
        };
        if (delay > 0) {
          window.setTimeout(startBot, i * delay);
        } else {
          startBot();
        }
      }
      setNextIndex(baseIndex + count);
      return;
    }

    const popupEntries: Array<{ handle: Window | null; url: string }> = [];
    for (let i = 0; i < count; i += 1) {
      const left = baseLeft + (i % columns) * (width + gap);
      const top = baseTop + Math.floor(i / columns) * (height + gap);
      const features = `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
      const handle = window.open(
        "about:blank",
        `conclave-dev-${Date.now()}-${i}`,
        features,
      );
      const label = `${namePrefix || "Dev"} ${baseIndex + i}`.trim();
      const sessionId = generateSessionId();
      const url = buildSpawnUrl(label, sessionId);
      popupEntries.push({ handle, url });
    }

    popupEntries.forEach(({ handle, url }, i) => {
      const assignLocation = () => {
        try {
          if (handle && !handle.closed) {
            handle.location.href = url;
          }
        } catch {
          // ignore navigation errors
        }
      };
      if (delay > 0) {
        window.setTimeout(assignLocation, i * delay);
      } else {
        assignLocation();
      }
      registerWindow(handle, autoCloseMs);
    });

    setNextIndex(baseIndex + count);
  }, [
    canSpawn,
    spawnCount,
    spawnDelayMs,
    autoCloseSeconds,
    nextIndex,
    namePrefix,
    buildSpawnUrl,
    registerWindow,
    spawnMethod,
    removeInlineBot,
    createHeadlessBot,
  ]);

  const closeAllWindows = useCallback(() => {
    openWindowsRef.current.forEach((handle) => {
      try {
        if (!handle.closed) {
          handle.close();
        }
      } catch {
      }
    });
    openWindowsRef.current = [];
    setOpenWindowsCount(0);
  }, []);

  const clearAllBots = useCallback(() => {
    closeAllWindows();
    setInlineBots([]);
    const headlessIds = Array.from(headlessSocketsRef.current.keys());
    headlessIds.forEach((id) => removeHeadlessBot(id));
  }, [closeAllWindows, removeHeadlessBot]);

  useEffect(
    () => () => {
      closeAllWindows();
      const headlessIds = Array.from(headlessSocketsRef.current.keys());
      headlessIds.forEach((id) => removeHeadlessBot(id));
    },
    [closeAllWindows, removeHeadlessBot],
  );

  const panelClass =
    "w-[320px] rounded-xl border border-[#FEFCD9]/15 bg-[#0d0e0d]/95 p-3 text-[11px] text-[#FEFCD9]/80 shadow-2xl backdrop-blur";
  const inputClass =
    "w-full rounded-md border border-[#FEFCD9]/10 bg-black/40 px-2.5 py-1.5 text-[11px] text-[#FEFCD9] outline-none focus:border-[#FEFCD9]/30";
  const labelClass =
    "text-[10px] uppercase tracking-[0.22em] text-[#FEFCD9]/40";
  const buttonClass =
    "rounded-md border border-[#FEFCD9]/15 px-2.5 py-1.5 text-[11px] uppercase tracking-[0.16em] text-[#FEFCD9]/80 transition hover:border-[#FEFCD9]/30 hover:text-[#FEFCD9]";

  const spawnSummary = useMemo(() => {
    if (!canSpawn) return "Set a room ID first.";
    return `Ready to spawn in ${roomId}.`;
  }, [canSpawn, roomId]);

  return (
    <div className="absolute bottom-24 left-4 z-[120] flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="rounded-full border border-[#FEFCD9]/20 bg-black/60 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[#FEFCD9]/80 hover:border-[#FEFCD9]/40"
      >
        Dev Tools
      </button>
      {isOpen && (
        <div className={panelClass}>
          <div className="flex items-center justify-between">
            <div>
              <div className={labelClass}>Dev panel</div>
              <p className="mt-1 text-[11px] text-[#FEFCD9]/70">
                {spawnSummary}
              </p>
            </div>
            <div className="text-[10px] text-[#FEFCD9]/45">
              Inline: {inlineBots.length} · Headless: {headlessCount} ·
              Windows: {openWindowsCount}
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <div>
              <div className={labelClass}>Count</div>
              <input
                type="number"
                min={1}
                max={50}
                value={spawnCount}
                onChange={(event) =>
                  setSpawnCount(
                    parseNumberInput(event.target.value, spawnCount, 1, 50),
                  )
                }
                className={inputClass}
              />
            </div>
            <div>
              <div className={labelClass}>Start #</div>
              <input
                type="number"
                min={1}
                max={9999}
                value={nextIndex}
                onChange={(event) =>
                  setNextIndex(
                    parseNumberInput(event.target.value, nextIndex, 1, 9999),
                  )
                }
                className={inputClass}
              />
            </div>
            <div className="col-span-2">
              <div className={labelClass}>Name prefix</div>
              <input
                value={namePrefix}
                onChange={(event) => setNamePrefix(event.target.value)}
                className={inputClass}
                placeholder="Dev"
              />
            </div>
            <div>
              <div className={labelClass}>Spawn method</div>
              <select
                value={spawnMethod}
                onChange={(event) =>
                  setSpawnMethod(event.target.value as SpawnMethod)
                }
                className={inputClass}
              >
                <option value="inline">Inline (hidden)</option>
                <option value="headless">Headless (socket-only)</option>
                <option value="popup">Popups</option>
              </select>
            </div>
            <div>
              <div className={labelClass}>Join mode</div>
              <select
                value={joinMode}
                onChange={(event) =>
                  setJoinMode(event.target.value as JoinMode)
                }
                className={inputClass}
              >
                <option value="meeting">Meeting</option>
                <option value="webinar_attendee">Webinar attendee</option>
              </select>
            </div>
            <div>
              <div className={labelClass}>Delay (ms)</div>
              <input
                type="number"
                min={0}
                max={5000}
                value={spawnDelayMs}
                onChange={(event) =>
                  setSpawnDelayMs(
                    parseNumberInput(event.target.value, spawnDelayMs, 0, 5000),
                  )
                }
                className={inputClass}
              />
            </div>
            <div>
              <div className={labelClass}>Auto-close (s)</div>
              <input
                type="number"
                min={0}
                max={3600}
                value={autoCloseSeconds}
                onChange={(event) =>
                  setAutoCloseSeconds(
                    parseNumberInput(
                      event.target.value,
                      autoCloseSeconds,
                      0,
                      3600,
                    ),
                  )
                }
                className={inputClass}
              />
            </div>
            <div>
              <div className={labelClass}>Flags</div>
              <div className="mt-1 flex flex-col gap-1.5 text-[11px] text-[#FEFCD9]/80">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={autoJoin}
                    onChange={(event) => setAutoJoin(event.target.checked)}
                  />
                  Auto-join
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={hideJoinUI}
                    onChange={(event) => setHideJoinUI(event.target.checked)}
                  />
                  Hide join UI
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={bypassMedia}
                    onChange={(event) => setBypassMedia(event.target.checked)}
                  />
                  Bypass media
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={asAdmin}
                    onChange={(event) => setAsAdmin(event.target.checked)}
                  />
                  Admin
                </label>
              </div>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={spawnParticipants}
              disabled={!canSpawn}
              className={`${buttonClass} ${!canSpawn ? "opacity-40" : ""}`}
            >
              Spawn
            </button>
            <button
              type="button"
              onClick={clearAllBots}
              className={buttonClass}
            >
              Clear all
            </button>
          </div>
        </div>
      )}
      {inlineBots.length > 0 && (
        <div className="pointer-events-none fixed left-0 top-0 h-0 w-0 overflow-hidden">
          {inlineBots.map((bot) => (
            <iframe
              key={bot.id}
              src={bot.url}
              title={`Dev bot ${bot.name}`}
              className="h-px w-px opacity-0"
            />
          ))}
        </div>
      )}
    </div>
  );
}
