"use client";

import { ArrowRight, Ghost, Globe, Hand, Loader2, Mic, MicOff } from "lucide-react";
import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import { useSmartParticipantOrder } from "../hooks/useSmartParticipantOrder";
import type { Participant } from "../lib/types";
import {
    isSystemUserId,
    normalizeBrowserUrl,
    resolveNoVncUrl,
} from "../lib/utils";
import ParticipantVideo from "./ParticipantVideo";
import { Avatar, NamePlate } from "@conclave/ui-tokens/web";
import { color } from "@conclave/ui-tokens";

interface BrowserLayoutProps {
    browserUrl: string;
    noVncUrl: string;
    controllerName: string;
    localStream: MediaStream | null;
    isCameraOff: boolean;
    isMuted: boolean;
    isHandRaised: boolean;
    isGhost: boolean;
    participants: Map<string, Participant>;
    userEmail: string;
    isMirrorCamera: boolean;
    activeSpeakerId: string | null;
    currentUserId: string;
    audioOutputDeviceId?: string;
    getDisplayName: (userId: string) => string;
    isAdmin?: boolean;
    isBrowserLaunching?: boolean;
    onNavigateBrowser?: (url: string) => Promise<boolean>;
    browserVideoStream?: MediaStream | null;
}

function BrowserLayout({
    browserUrl,
    noVncUrl,
    controllerName,
    localStream,
    isCameraOff,
    isMuted,
    isHandRaised,
    isGhost,
    participants,
    userEmail,
    isMirrorCamera,
    activeSpeakerId,
    currentUserId,
    audioOutputDeviceId,
    getDisplayName,
    isAdmin,
    isBrowserLaunching = false,
    onNavigateBrowser,
    browserVideoStream,
}: BrowserLayoutProps) {
    const localVideoRef = useRef<HTMLVideoElement>(null);
    const browserVideoRef = useRef<HTMLVideoElement>(null);
    const isLocalActiveSpeaker = activeSpeakerId === currentUserId;
    const [isReady, setIsReady] = useState(false);
    const [navInput, setNavInput] = useState(browserUrl);
    const [navError, setNavError] = useState<string | null>(null);

    // The shared browser frame reveals itself on its own `load` event. The
    // timer is only a fallback so a frame that never fires `load` (e.g. blocked
    // by the network) still resolves instead of spinning forever.
    useEffect(() => {
        setIsReady(false);
        if (!noVncUrl) return;

        const timer = setTimeout(() => {
            setIsReady(true);
        }, 8000);
        return () => clearTimeout(timer);
    }, [noVncUrl]);

    useEffect(() => {
        const video = localVideoRef.current;
        if (!video) return;

        if (!localStream) {
            if (video.srcObject) {
                video.srcObject = null;
            }
            return;
        }

        video.srcObject = localStream;
        video.play().catch((err) => {
            if (err.name !== "AbortError") {
                console.error("[Meets] Browser layout local video play error:", err);
            }
        });

        return () => {
            if (video.srcObject === localStream) {
                video.srcObject = null;
            }
        };
    }, [localStream]);

    useEffect(() => {
        const video = browserVideoRef.current;
        if (!video) return;

        if (!browserVideoStream) {
            if (video.srcObject) {
                video.srcObject = null;
            }
            return;
        }

        video.srcObject = browserVideoStream;
        video.play().catch((err) => {
            if (err.name !== "AbortError") {
                console.error("[Meets] Browser video play error:", err);
            }
        });

        return () => {
            if (video.srcObject === browserVideoStream) {
                video.srcObject = null;
            }
        };
    }, [browserVideoStream]);

    useEffect(() => {
        setNavInput(browserUrl);
    }, [browserUrl]);

    const displayUrl = (() => {
        try {
            const url = new URL(browserUrl);
            return url.hostname;
        } catch {
            return browserUrl;
        }
    })();

    const resolvedNoVncUrl = resolveNoVncUrl(noVncUrl);
    const remoteParticipants = useSmartParticipantOrder(
        Array.from(participants.values()).filter(
            (participant) =>
                participant.userId !== currentUserId &&
                !isSystemUserId(participant.userId)
        ),
        activeSpeakerId
    );

    const localName = getDisplayName(currentUserId) || userEmail;

    return (
        <div className="mt-5 flex flex-1 min-h-0 min-w-0 gap-4 overflow-hidden">
            <div
                className="flex-1 min-h-0 min-w-0 rounded-2xl overflow-hidden relative flex flex-col"
                style={{
                    backgroundColor: color.surface,
                    border: `1px solid ${color.border}`,
                }}
            >
                {isAdmin && onNavigateBrowser && (
                    <div
                        className="px-3 py-2.5"
                        style={{ borderBottom: `1px solid ${color.border}` }}
                    >
                        <form
                            onSubmit={async (event: FormEvent) => {
                                event.preventDefault();
                                const normalized = normalizeBrowserUrl(navInput);
                                if (!normalized.url) {
                                    setNavError(normalized.error ?? "Enter a valid URL.");
                                    return;
                                }
                                setNavError(null);
                                await onNavigateBrowser(normalized.url);
                            }}
                            className="flex items-center gap-2"
                        >
                            <div
                                className="flex flex-1 items-center gap-2 rounded-full px-3 py-2 transition-[border-color] duration-[120ms] focus-within:border-text/25"
                                style={{
                                    backgroundColor: color.bgAlt,
                                    border: `1px solid ${color.border}`,
                                }}
                            >
                                <Globe
                                    size={18}
                                    strokeWidth={1.75}
                                    className="shrink-0"
                                    style={{ color: color.textMuted }}
                                />
                                <input
                                    type="text"
                                    value={navInput}
                                    onChange={(event) => {
                                        setNavInput(event.target.value);
                                        if (navError) {
                                            setNavError(null);
                                        }
                                    }}
                                    placeholder="Navigate to a URL"
                                    className="flex-1 bg-transparent text-[14px] focus:outline-none"
                                    style={{ color: color.text }}
                                />
                            </div>
                            <button
                                type="submit"
                                disabled={!navInput.trim() || isBrowserLaunching}
                                className="inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2 text-[14px] font-medium text-white transition-[filter] duration-[120ms] hover:brightness-110 active:brightness-95 disabled:opacity-35 disabled:cursor-not-allowed"
                                style={{ backgroundColor: color.accent }}
                            >
                                {isBrowserLaunching ? (
                                    <Loader2 size={18} strokeWidth={1.75} className="animate-spin" />
                                ) : (
                                    <>
                                        Go
                                        <ArrowRight size={18} strokeWidth={1.75} />
                                    </>
                                )}
                            </button>
                        </form>
                        {navError && (
                            <p className="mt-2 text-[12.5px]" style={{ color: color.accent }}>
                                {navError}
                            </p>
                        )}
                    </div>
                )}
                <div className="flex-1 min-h-0 flex items-center justify-center bg-black overflow-hidden">
                    {browserVideoStream ? (
                        <div
                            className="relative bg-black"
                            style={{
                                width: "min(100%, calc((100vh - 200px) * 16 / 9))",
                                aspectRatio: "16 / 9",
                            }}
                        >
                            <video
                                ref={browserVideoRef}
                                autoPlay
                                playsInline
                                muted
                                className="absolute inset-0 w-full h-full"
                                style={{ objectFit: "fill", pointerEvents: "none" }}
                            />
                            <iframe
                                src={`${resolvedNoVncUrl}${resolvedNoVncUrl.includes("?") ? "&" : "?"}autoconnect=true&resize=scale&quality=0&compression=9`}
                                onLoad={() => setIsReady(true)}
                                className="absolute inset-0 w-full h-full border-0"
                                style={{ opacity: 0, pointerEvents: "auto" }}
                                allow="clipboard-read; clipboard-write"
                                title="Shared Browser Input"
                            />
                        </div>
                    ) : (
                        <div className="relative h-full w-full">
                            <iframe
                                src={resolvedNoVncUrl}
                                onLoad={() => setIsReady(true)}
                                className="h-full w-full border-0 transition-opacity duration-200"
                                style={{ opacity: isReady ? 1 : 0 }}
                                allow="clipboard-read; clipboard-write"
                                title="Shared Browser"
                            />
                            {!isReady && (
                                <div
                                    className="absolute inset-0 flex flex-col items-center justify-center gap-3"
                                    style={{ backgroundColor: color.surface }}
                                >
                                    <div
                                        className="flex h-16 w-16 items-center justify-center rounded-full"
                                        style={{ backgroundColor: color.accentSoft }}
                                    >
                                        <Globe size={28} strokeWidth={1.75} style={{ color: color.accent }} />
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <Loader2
                                            size={18}
                                            strokeWidth={1.75}
                                            className="animate-spin"
                                            style={{ color: color.textMuted }}
                                        />
                                        <span className="text-[14px]" style={{ color: color.textMuted }}>
                                            Starting browser
                                        </span>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <div
                    className="flex items-center justify-between px-3 py-2.5"
                    style={{ borderTop: `1px solid ${color.border}` }}
                >
                    <div className="flex items-center gap-2 min-w-0">
                        <Globe
                            size={18}
                            strokeWidth={1.75}
                            className="shrink-0"
                            style={{ color: color.textMuted }}
                        />
                        <span
                            className="truncate text-[12.5px] font-medium"
                            style={{ color: color.text }}
                        >
                            {displayUrl}
                        </span>
                    </div>
                    <div
                        className="flex shrink-0 items-center gap-2 text-[12.5px]"
                        style={{ color: color.textMuted }}
                    >
                        <span
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ backgroundColor: color.success }}
                        />
                        {controllerName} is sharing
                    </div>
                </div>
            </div>

            <div className="w-64 shrink-0 flex flex-col gap-3 overflow-y-auto overflow-x-visible px-1">
                <div className={`acm-video-tile h-36 shrink-0 ${isLocalActiveSpeaker ? "speaking" : ""}`}>
                    <video
                        ref={localVideoRef}
                        autoPlay
                        muted
                        playsInline
                        className={`w-full h-full object-cover ${isCameraOff ? "hidden" : ""
                            } ${isMirrorCamera ? "scale-x-[-1]" : ""}`}
                    />
                    {isCameraOff && (
                        <div
                            className="absolute inset-0 flex items-center justify-center"
                            style={{ backgroundColor: color.surface }}
                        >
                            <Avatar name={localName} id={currentUserId} size={48} />
                        </div>
                    )}
                    {isGhost && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/40">
                            <div className="flex flex-col items-center gap-1.5">
                                <Ghost size={40} strokeWidth={1.75} style={{ color: color.accentSecondary }} />
                                <span
                                    className="rounded-full px-2.5 py-0.5 text-[11px] font-medium"
                                    style={{
                                        color: color.accentSecondary,
                                        backgroundColor: color.scrim,
                                        border: `1px solid ${color.border}`,
                                    }}
                                >
                                    Ghost
                                </span>
                            </div>
                        </div>
                    )}
                    {isHandRaised && (
                        <div
                            className="absolute top-3 left-3 rounded-full p-1.5 text-amber-300"
                            style={{
                                backgroundColor: "rgba(251, 191, 36, 0.2)",
                                border: "1px solid rgba(251, 191, 36, 0.4)",
                            }}
                            title="Hand raised"
                        >
                            <Hand size={18} strokeWidth={1.75} className="h-3.5 w-3.5" />
                        </div>
                    )}
                    <div className="absolute bottom-3 left-3 max-w-[80%]">
                        <NamePlate name="You" isLocal />
                    </div>
                    <div
                        className="absolute bottom-3 right-3 inline-flex items-center justify-center rounded-full p-1.5"
                        style={{ backgroundColor: color.scrim, border: `1px solid ${color.border}` }}
                        title={isMuted ? "Microphone off" : "Microphone on"}
                    >
                        {isMuted ? (
                            <MicOff size={18} strokeWidth={1.75} className="h-3.5 w-3.5" style={{ color: color.accent }} />
                        ) : (
                            <Mic size={18} strokeWidth={1.75} className="h-3.5 w-3.5" style={{ color: color.success }} />
                        )}
                    </div>
                </div>

                {remoteParticipants.map((participant) => (
                        <ParticipantVideo
                            key={participant.userId}
                            participant={participant}
                            displayName={getDisplayName(participant.userId)}
                            isActiveSpeaker={activeSpeakerId === participant.userId}
                            compact
                            audioOutputDeviceId={audioOutputDeviceId}
                        />
                    ))}
            </div>
        </div>
    );
}

export default memo(BrowserLayout);
