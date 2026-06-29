"use client";

import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Avatar } from "@conclave/ui-tokens/web";
import { useSmartParticipantOrder } from "./useSmartParticipantOrder";
import { getRenderableParticipantVideoStream } from "../lib/participant-media";
import type { Participant } from "../lib/types";
import { isSystemUserId } from "../lib/utils";


interface DocumentPictureInPictureWindow extends Window {
}

interface DocumentPictureInPicture extends EventTarget {
  requestWindow(options?: {
    width?: number;
    height?: number;
    disallowReturnToOpener?: boolean;
  }): Promise<DocumentPictureInPictureWindow>;
  window: DocumentPictureInPictureWindow | null;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture;
  }
}

export interface UseMeetPopoutOptions {
  isJoined: boolean;
  localStream: MediaStream | null;
  participants: Map<string, Participant>;
  activeSpeakerId: string | null;
  currentUserId: string;
  isCameraOff: boolean;
  isMuted: boolean;
  mirrorLocalPreview: boolean;
  userEmail: string;
  getDisplayName: (userId: string) => string;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onLeave: () => void;
}

export interface PopoutState {
  isPopoutActive: boolean;
  isPopoutSupported: boolean;
  openPopout: () => Promise<void>;
  closePopout: () => void;
}


const POPOUT_CSS = `
  @font-face {
    font-family: 'PolySans Trial';
    src: local('PolySans Trial');
    font-display: swap;
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'PolySans Trial', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #131316;
    color: #fafafa;
    overflow: hidden;
    user-select: none;
    -webkit-user-select: none;
  }

  .popout-root {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
  }

  .popout-videos {
    flex: 1;
    display: grid;
    gap: 6px;
    padding: 6px;
    min-height: 0;
    overflow: hidden;
  }

  .popout-videos.single {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr;
  }

  .popout-videos.dual {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr;
  }

  .popout-videos.multi {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
  }

  .video-tile {
    position: relative;
    border-radius: 16px;
    overflow: hidden;
    background: #131316;
    border: 1px solid rgba(250, 250, 250, 0.08);
    /* Active-speaker ring is an INSET shadow (matching the in-call tile), not a
       border-width change — toggling 1px→2px resized the video box on every
       speaker change and read as jitter. */
    transition: border-color 0.12s ease, box-shadow 0.12s ease;
    min-width: 0;
    min-height: 0;
  }

  .video-tile:hover {
    border-color: rgba(250, 250, 250, 0.15);
  }

  .video-tile.speaking {
    border-color: transparent;
    box-shadow:
      inset 0 0 0 1px rgba(249, 95, 74, 0.72),
      0 0 0 1px rgba(249, 95, 74, 0.14);
  }

  .video-tile video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .video-tile .avatar-placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #18181b;
  }

  .video-tile .avatar-mount {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .video-tile .label {
    position: absolute;
    bottom: 8px;
    left: 8px;
    max-width: calc(100% - 16px);
    padding: 5px 12px;
    background: rgba(0, 0, 0, 0.7);
    border: 1px solid rgba(250, 250, 250, 0.1);
    border-radius: 9999px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: 'PolySans Trial', sans-serif;
  }

  .video-tile .label-name {
    font-size: 11px;
    font-weight: 500;
    color: #fafafa;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .video-tile .label-you {
    flex-shrink: 0;
    font-size: 11px;
    font-weight: 500;
    color: #F95F4A;
  }

  .video-tile .label-muted {
    flex-shrink: 0;
    color: #F95F4A;
    display: none;
    align-items: center;
  }

  .video-tile .label-muted svg {
    width: 11px;
    height: 11px;
  }

  /* Active-speaker voice bars — mirrors .acm-voice-activity in the call UI. */
  .video-tile .label-voice {
    display: none;
    width: 13px;
    height: 10px;
    flex-shrink: 0;
    align-items: flex-end;
    gap: 2px;
    color: #F95F4A;
  }

  .video-tile .label-voice > span {
    width: 2px;
    height: 7px;
    border-radius: 999px;
    background: currentColor;
    opacity: 0.7;
    transform: scaleY(0.5);
    transform-origin: center bottom;
    animation: popout-voice 780ms ease-in-out infinite;
  }

  .video-tile .label-voice > span:nth-child(2) { animation-delay: 120ms; }
  .video-tile .label-voice > span:nth-child(3) { animation-delay: 240ms; }

  @keyframes popout-voice {
    0%, 100% { opacity: 0.48; transform: scaleY(0.42); }
    45% { opacity: 1; transform: scaleY(1); }
  }

  .popout-controls {
    position: absolute;
    bottom: 10px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 4px 6px;
    background: rgba(10, 10, 11, 0.72);
    border: 1px solid rgba(250, 250, 250, 0.08);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-radius: 9999px;
    z-index: 10;
    font-family: 'PolySans Trial', sans-serif;
  }

  /* Flat ghost icon buttons — matches the redesigned in-call control bar. */
  .ctrl-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 9999px;
    border: none;
    background: transparent;
    color: rgba(250, 250, 250, 0.7);
    cursor: pointer;
    transition: background-color 0.12s ease, color 0.12s ease;
    outline: none;
  }

  .ctrl-btn:hover {
    color: #fafafa;
    background: rgba(255, 255, 255, 0.08);
  }

  /* Toggled-off (muted mic / camera off) reads in accent, like the call bar. */
  .ctrl-btn.muted {
    color: #F95F4A;
  }

  .ctrl-btn.muted:hover {
    color: #F95F4A;
    background: rgba(249, 95, 74, 0.12);
  }

  .ctrl-btn svg {
    width: 15px;
    height: 15px;
  }

  .ctrl-divider {
    width: 1px;
    height: 18px;
    background: rgba(250, 250, 250, 0.1);
    margin: 0 1px;
  }

  /* Leave = solid red pill, identical intent to the in-call hang-up button. */
  .ctrl-btn.leave {
    width: 42px;
    color: #ffffff;
    background: #ea4335;
  }

  .ctrl-btn.leave:hover {
    color: #ffffff;
    background: #e8533f;
  }

  .ctrl-btn.leave svg {
    transform: rotate(135deg);
  }
`;


const MIC_ON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`;
const MIC_OFF_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5.87"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`;
const CAM_ON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>`;
const CAM_OFF_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/><line x1="2" x2="22" y1="2" y2="22"/></svg>`;
const PHONE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;
const MIC_OFF_SMALL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5.87"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`;


export function useMeetPopout({
  isJoined,
  localStream,
  participants,
  activeSpeakerId,
  currentUserId,
  isCameraOff,
  isMuted,
  mirrorLocalPreview,
  userEmail,
  getDisplayName,
  onToggleMute,
  onToggleCamera,
  onLeave,
}: UseMeetPopoutOptions): PopoutState {
  const [isPopoutActive, setIsPopoutActive] = useState(false);
  const popoutWindowRef = useRef<Window | null>(null);
  const updateIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const videoElementsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const avatarRootsRef = useRef<Map<string, Root>>(new Map());
  const popoutListenerCleanupsRef = useRef<Array<() => void>>([]);

  const onToggleMuteRef = useRef(onToggleMute);
  const onToggleCameraRef = useRef(onToggleCamera);
  const onLeaveRef = useRef(onLeave);
  const updatePopoutRef = useRef<(() => void) | null>(null);
  useEffect(() => { onToggleMuteRef.current = onToggleMute; }, [onToggleMute]);
  useEffect(() => { onToggleCameraRef.current = onToggleCamera; }, [onToggleCamera]);
  useEffect(() => { onLeaveRef.current = onLeave; }, [onLeave]);

  const isPopoutSupported =
    typeof window !== "undefined" && "documentPictureInPicture" in window;

  const remoteParticipants = useSmartParticipantOrder(
    Array.from(participants.entries())
      .filter(([userId]) => userId !== currentUserId && !isSystemUserId(userId))
      .map(([userId, participant]) => ({
        userId,
        displayName: getDisplayName(userId),
        videoStream: participant.videoStream ?? null,
        isCameraOff: participant.isCameraOff,
        isVideoAdaptivelyPaused: participant.isVideoAdaptivelyPaused,
        isMuted: participant.isMuted,
        isLocal: false,
        isActiveSpeaker: activeSpeakerId === userId,
      })),
    activeSpeakerId
  );

  const getVisibleParticipants = useCallback(() => {
    const visible: Array<{
      userId: string;
      displayName: string;
      videoStream: MediaStream | null;
      isCameraOff: boolean;
      isVideoAdaptivelyPaused: boolean;
      isMuted: boolean;
      isLocal: boolean;
      isActiveSpeaker: boolean;
    }> = [];

    visible.push({
      userId: currentUserId,
      displayName: getDisplayName(currentUserId),
      videoStream: localStream,
      isCameraOff,
      isVideoAdaptivelyPaused: false,
      isMuted,
      isLocal: true,
      isActiveSpeaker: activeSpeakerId === currentUserId,
    });

    visible.push(...remoteParticipants);

    return visible;
  }, [
    currentUserId,
    localStream,
    isCameraOff,
    isMuted,
    activeSpeakerId,
    remoteParticipants,
    getDisplayName,
  ]);

  const updatePopoutContent = useCallback(() => {
    const pipWin = popoutWindowRef.current;
    if (!pipWin || pipWin.closed) {
      setIsPopoutActive(false);
      return;
    }

    const doc = pipWin.document;
    const allParticipants = getVisibleParticipants();
    const totalCount = allParticipants.length;

    let showParticipants = allParticipants;
    if (totalCount > 4) {
      const activeSpeaker = allParticipants.find((p) => p.isActiveSpeaker && !p.isLocal);
      const local = allParticipants.find((p) => p.isLocal);
      const others = allParticipants.filter((p) => !p.isLocal && !p.isActiveSpeaker);
      showParticipants = [local, activeSpeaker, ...others].filter(Boolean).slice(0, 4) as typeof allParticipants;
    }

    const grid = doc.getElementById("p-videos");
    if (!grid) return;

    const layoutClass =
      showParticipants.length === 1
        ? "single"
        : showParticipants.length === 2
          ? "dual"
          : "multi";
    grid.className = `popout-videos ${layoutClass}`;

    const currentIds = new Set(showParticipants.map((p) => p.userId));

    for (const child of Array.from(grid.children)) {
      const tileUserId = (child as HTMLElement).dataset.userId;
      if (tileUserId && !currentIds.has(tileUserId)) {
        const vid = videoElementsRef.current.get(tileUserId);
        if (vid) {
          vid.srcObject = null;
          videoElementsRef.current.delete(tileUserId);
        }
        const root = avatarRootsRef.current.get(tileUserId);
        if (root) {
          root.unmount();
          avatarRootsRef.current.delete(tileUserId);
        }
        child.remove();
      }
    }

    for (const participant of showParticipants) {
      let tile = doc.querySelector(
        `[data-user-id="${participant.userId}"]`
      ) as HTMLElement | null;

      if (!tile) {
        tile = doc.createElement("div");
        tile.className = "video-tile";
        tile.dataset.userId = participant.userId;
        tile.innerHTML = `
          <div class="avatar-placeholder" style="display: none;">
            <div class="avatar-mount"></div>
          </div>
          <video autoplay playsinline muted style="display: none;"></video>
          <div class="label">
            <span class="label-name"></span>
            <span class="label-you" style="display: none;">You</span>
            <span class="label-voice"><span></span><span></span><span></span></span>
            <span class="label-muted">${MIC_OFF_SMALL_SVG}</span>
          </div>
        `;
        grid.appendChild(tile);
      }

      tile.classList.toggle("speaking", participant.isActiveSpeaker);

      const video = tile.querySelector("video") as HTMLVideoElement;
      const avatar = tile.querySelector(".avatar-placeholder") as HTMLElement;
      const avatarMount = tile.querySelector(".avatar-mount") as HTMLElement;
      const labelName = tile.querySelector(".label-name") as HTMLElement;
      const labelYou = tile.querySelector(".label-you") as HTMLElement;
      const labelVoice = tile.querySelector(".label-voice") as HTMLElement;
      const labelMuted = tile.querySelector(".label-muted") as HTMLElement;

      const participantVideoStream = participant.isLocal
        ? participant.videoStream
        : getRenderableParticipantVideoStream(participant);
      if (participantVideoStream && !participant.isCameraOff) {
        video.style.display = "block";
        avatar.style.display = "none";
        if (video.srcObject !== participantVideoStream) {
          video.srcObject = participantVideoStream;
          videoElementsRef.current.set(participant.userId, video);
        }
        video.play().catch(() => {});
        video.style.transform =
          participant.isLocal && mirrorLocalPreview ? "scaleX(-1)" : "";
      } else {
        video.style.display = "none";
        avatar.style.display = "flex";
        // Render the SAME Facehash <Avatar> the in-call tiles use, into the PiP
        // document (shared JS realm). Only re-render when the seed changes so
        // the 250ms refresh loop stays a no-op for a stable participant.
        const seed = `${participant.displayName}:${participant.userId}`;
        if (avatarMount && avatarMount.dataset.seed !== seed) {
          let root = avatarRootsRef.current.get(participant.userId);
          if (!root) {
            root = createRoot(avatarMount);
            avatarRootsRef.current.set(participant.userId, root);
          }
          root.render(
            createElement(Avatar, {
              name: participant.displayName,
              id: participant.userId,
              size: 72,
            }),
          );
          avatarMount.dataset.seed = seed;
        }
        if (video.srcObject) {
          video.srcObject = null;
          videoElementsRef.current.delete(participant.userId);
        }
      }

      labelName.textContent = participant.displayName;
      labelYou.style.display = participant.isLocal ? "inline" : "none";
      // Voice bars only when actively speaking and not muted; otherwise the
      // mic-off glyph takes over (the two never show together).
      const showVoice = participant.isActiveSpeaker && !participant.isMuted;
      labelVoice.style.display = showVoice ? "inline-flex" : "none";
      labelMuted.style.display = participant.isMuted ? "flex" : "none";
    }

    const muteBtn = doc.getElementById("btn-mute");
    const camBtn = doc.getElementById("btn-cam");
    if (muteBtn) {
      muteBtn.className = `ctrl-btn${isMuted ? " muted" : ""}`;
      muteBtn.innerHTML = isMuted ? MIC_OFF_SVG : MIC_ON_SVG;
    }
    if (camBtn) {
      camBtn.className = `ctrl-btn${isCameraOff ? " muted" : ""}`;
      camBtn.innerHTML = isCameraOff ? CAM_OFF_SVG : CAM_ON_SVG;
    }
  }, [getVisibleParticipants, isMuted, isCameraOff, mirrorLocalPreview]);

  useEffect(() => { updatePopoutRef.current = updatePopoutContent; }, [updatePopoutContent]);

  const cleanupPopoutResources = useCallback(() => {
    popoutListenerCleanupsRef.current.forEach((cleanup) => cleanup());
    popoutListenerCleanupsRef.current = [];
    if (updateIntervalRef.current) {
      clearInterval(updateIntervalRef.current);
      updateIntervalRef.current = null;
    }
    for (const vid of videoElementsRef.current.values()) {
      vid.srcObject = null;
    }
    videoElementsRef.current.clear();
    for (const root of avatarRootsRef.current.values()) {
      root.unmount();
    }
    avatarRootsRef.current.clear();
  }, []);

  const openPopout = useCallback(async () => {
    if (!isPopoutSupported || !isJoined || isPopoutActive) return;

    let pipWin: Window | null = null;
    try {
      cleanupPopoutResources();
      pipWin = await window.documentPictureInPicture!.requestWindow({
        width: 380,
        height: 320,
        disallowReturnToOpener: false,
      });

      popoutWindowRef.current = pipWin;
      setIsPopoutActive(true);

      for (const sheet of document.styleSheets) {
        try {
          if (sheet.href) {
            const link = pipWin.document.createElement("link");
            link.rel = "stylesheet";
            link.href = sheet.href;
            pipWin.document.head.appendChild(link);
          } else if (sheet.cssRules) {
            let hasRelevantFonts = false;
            for (const rule of sheet.cssRules) {
              if (rule instanceof CSSFontFaceRule && rule.cssText.includes("PolySans")) {
                hasRelevantFonts = true;
                break;
              }
            }
            if (hasRelevantFonts) {
              const style = pipWin.document.createElement("style");
              let fontRules = "";
              for (const rule of sheet.cssRules) {
                if (rule instanceof CSSFontFaceRule) {
                  fontRules += rule.cssText + "\n";
                }
              }
              style.textContent = fontRules;
              pipWin.document.head.appendChild(style);
            }
          }
        } catch {
        }
      }

      const style = pipWin.document.createElement("style");
      style.textContent = POPOUT_CSS;
      pipWin.document.head.appendChild(style);

      pipWin.document.title = "Conclave · Mini Meet";

      pipWin.document.body.innerHTML = `
        <div class="popout-root">
          <div id="p-videos" class="popout-videos single"></div>
          <div class="popout-controls">
            <button id="btn-mute" class="ctrl-btn" title="Toggle Mute">${MIC_ON_SVG}</button>
            <button id="btn-cam" class="ctrl-btn" title="Toggle Camera">${CAM_ON_SVG}</button>
            <div class="ctrl-divider"></div>
            <button id="btn-leave" class="ctrl-btn leave" title="Leave Call">${PHONE_SVG}</button>
          </div>
        </div>
      `;

      const registerPopoutListener = (
        target: EventTarget | null,
        type: string,
        listener: EventListener,
      ) => {
        if (!target) return;
        target.addEventListener(type, listener);
        popoutListenerCleanupsRef.current.push(() => {
          target.removeEventListener(type, listener);
        });
      };

      registerPopoutListener(pipWin.document.getElementById("btn-mute"), "click", () => {
        onToggleMuteRef.current();
      });

      registerPopoutListener(pipWin.document.getElementById("btn-cam"), "click", () => {
        onToggleCameraRef.current();
      });

      registerPopoutListener(pipWin.document.getElementById("btn-leave"), "click", () => {
        onLeaveRef.current();
        pipWin?.close();
      });

      updatePopoutContent();

      updateIntervalRef.current = setInterval(() => {
        updatePopoutRef.current?.();
      }, 250);

      registerPopoutListener(pipWin, "pagehide", () => {
        setIsPopoutActive(false);
        popoutWindowRef.current = null;
        cleanupPopoutResources();
      });
    } catch (err) {
      cleanupPopoutResources();
      if (pipWin && !pipWin.closed) {
        pipWin.close();
      }
      popoutWindowRef.current = null;
      setIsPopoutActive(false);
      console.warn("[Popout] Failed to open popout:", err);
    }
  }, [
    isPopoutSupported,
    isJoined,
    isPopoutActive,
    updatePopoutContent,
    cleanupPopoutResources,
  ]);

  const closePopout = useCallback(() => {
    const pipWin = popoutWindowRef.current;
    if (pipWin && !pipWin.closed) {
      pipWin.close();
    }
    setIsPopoutActive(false);
    popoutWindowRef.current = null;
    cleanupPopoutResources();
  }, [cleanupPopoutResources]);


  useEffect(() => {
    if (!isPopoutActive || !popoutWindowRef.current) return;
    updatePopoutContent();
  }, [isPopoutActive, updatePopoutContent]);


  useEffect(() => {
    if (!isJoined && isPopoutActive) {
      closePopout();
    }
  }, [isJoined, isPopoutActive, closePopout]);


  useEffect(() => {
    return () => {
      cleanupPopoutResources();
      const pipWin = popoutWindowRef.current;
      if (pipWin && !pipWin.closed) {
        pipWin.close();
      }
    };
  }, [cleanupPopoutResources]);

  return {
    isPopoutActive,
    isPopoutSupported,
    openPopout,
    closePopout,
  };
}
