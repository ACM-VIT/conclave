"use client";

import { errorName } from "../lib/utils";
import { Globe, Hand, Loader2, Mic, MicOff } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useSmartParticipantOrder } from "../hooks/useSmartParticipantOrder";
import type { Participant } from "../lib/types";
import {
    isSystemUserId,
    resolveNoVncUrl,
} from "../lib/utils";
import ParticipantVideo from "./ParticipantVideo";
import { Avatar, NamePlate } from "@conclave/ui-tokens/web";
import { color } from "@conclave/ui-tokens";

interface BrowserLayoutProps {
    noVncUrl: string;
    controllerName: string;
    localStream: MediaStream | null;
    isCameraOff: boolean;
    isMuted: boolean;
    isHandRaised: boolean;
    participants: Map<string, Participant>;
    userEmail: string;
    isMirrorCamera: boolean;
    activeSpeakerId: string | null;
    currentUserId: string;
    audioOutputDeviceId?: string;
    onAudioAutoplayBlocked?: () => void;
    onAudioPlaybackStarted?: () => void;
    audioPlaybackAttemptToken?: number;
    getDisplayName: (userId: string) => string;
    provider?: "chromium" | "kitesurf";
    browserVideoStream?: MediaStream | null;
}

function BrowserLayout({
    noVncUrl,
    controllerName,
    localStream,
    isCameraOff,
    isMuted,
    isHandRaised,
    participants,
    userEmail,
    isMirrorCamera,
    activeSpeakerId,
    currentUserId,
    audioOutputDeviceId,
    onAudioAutoplayBlocked,
    onAudioPlaybackStarted,
    audioPlaybackAttemptToken,
    getDisplayName,
    provider = "chromium",
    browserVideoStream,
}: BrowserLayoutProps) {
    const localVideoRef = useRef<HTMLVideoElement>(null);
    const browserVideoRef = useRef<HTMLVideoElement>(null);
    const isLocalActiveSpeaker = activeSpeakerId === currentUserId;
    const [isReady, setIsReady] = useState(false);

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
            if (errorName(err) !== "AbortError") {
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
            if (errorName(err) !== "AbortError") {
                console.error("[Meets] Browser video play error:", err);
            }
        });

        return () => {
            if (video.srcObject === browserVideoStream) {
                video.srcObject = null;
            }
        };
    }, [browserVideoStream]);

    const resolvedNoVncUrl = resolveNoVncUrl(noVncUrl);
    const remoteParticipantList = useMemo(
        () => Array.from(participants.values()).filter(
            (participant) =>
                participant.userId !== currentUserId &&
                !isSystemUserId(participant.userId),
        ),
        [currentUserId, participants],
    );
    const remoteParticipants = useSmartParticipantOrder(
        remoteParticipantList,
        activeSpeakerId
    );

    const localName = getDisplayName(currentUserId) || userEmail;
    const displayControllerName = controllerName.trim() || "host";
    const isKitesurf = provider === "kitesurf";
    const providerLabel = isKitesurf ? "Kitesurf" : "Shared browser";
    const providerDetail = isKitesurf ? "Cloudflare Browser Run" : "Chromium";

    return (
        <div className="mt-3 grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-3 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_13rem] lg:overflow-hidden">
            <section
                className="relative flex min-h-[420px] min-w-0 flex-col overflow-hidden rounded-2xl lg:min-h-0"
                style={{
                    backgroundColor: color.surface,
                    border: `1px solid ${color.border}`,
                }}
                aria-label="Shared browser workspace"
                data-browser-provider={provider}
            >
                <header
                    className="flex h-10 shrink-0 items-center justify-between gap-3 px-3"
                    style={{ borderBottom: `1px solid ${color.border}` }}
                >
                    <div className="flex min-w-0 items-center gap-2">
                        <span
                            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                            style={{ backgroundColor: color.accentSoft, color: color.accent }}
                        >
                            <Globe size={13} strokeWidth={1.8} />
                        </span>
                        <span className="truncate text-[11px] font-semibold" style={{ color: color.text }}>
                            {providerLabel}
                        </span>
                        <span className="hidden text-[10px] sm:inline" style={{ color: color.textFaint }}>
                            {providerDetail}
                        </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2.5 text-[10px]" style={{ color: color.textFaint }}>
                        <span className="inline-flex items-center gap-1.5 font-medium uppercase tracking-[0.12em]">
                            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color.success }} />
                            Live
                        </span>
                        <span className="hidden sm:inline">
                            Shared by <span style={{ color: color.textMuted }}>{displayControllerName}</span>
                        </span>
                    </div>
                </header>

                <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">
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
                                style={{
                                    opacity: 0,
                                    pointerEvents: "auto",
                                }}
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
                                style={{
                                    opacity: isReady ? 1 : 0,
                                    pointerEvents: "auto",
                                }}
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

            </section>

            <aside className="min-h-[160px] min-w-0 lg:min-h-0">
                <section
                    className="overflow-hidden rounded-2xl"
                    style={{ backgroundColor: color.surface, border: `1px solid ${color.border}` }}
                    aria-label="Meeting participants"
                >
                    <div className="flex max-h-44 gap-2 overflow-auto p-2 lg:max-h-52 lg:flex-col">
                        <div className={`acm-video-tile h-28 w-40 shrink-0 lg:w-auto ${isLocalActiveSpeaker ? "speaking" : ""}`}>
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
                                    <Avatar name={localName} id={currentUserId} size={38} />
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
                            <div className="absolute bottom-3 left-3 flex max-w-[80%] items-center gap-1.5">
                                <NamePlate name="You" isLocal />
                                {isLocalActiveSpeaker && !isMuted ? (
                                    <span
                                        className="rounded-full px-2 py-1"
                                        style={{
                                            backgroundColor: color.scrim,
                                            border: `1px solid ${color.border}`,
                                        }}
                                    >
                                        <span className="acm-voice-activity" aria-label="Speaking">
                                            <span />
                                            <span />
                                            <span />
                                        </span>
                                    </span>
                                ) : null}
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
                                onAudioAutoplayBlocked={onAudioAutoplayBlocked}
                                onAudioPlaybackStarted={onAudioPlaybackStarted}
                                audioPlaybackAttemptToken={audioPlaybackAttemptToken}
                            />
                        ))}
                    </div>
                </section>
            </aside>
        </div>
    );
}

export default memo(BrowserLayout);
