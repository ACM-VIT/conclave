"use client";

import { Ghost, Globe, Hand, Loader2 } from "lucide-react";
import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import type { Participant } from "../types";
import {
    getSpeakerHighlightClasses,
    isSystemUserId,
    normalizeBrowserUrl,
    resolveNoVncUrl,
} from "../utils";
import ParticipantVideo from "./ParticipantVideo";

interface BrowserLayoutProps {
    browserUrl: string;
    noVncUrl: string;
    controllerName: string;
    localStream: MediaStream | null;
    isCameraOff: boolean;
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

    // Wait for browser container to be ready before showing iframe
    useEffect(() => {
        if (noVncUrl) {
            const timer = setTimeout(() => {
                setIsReady(true);
            }, 3000); // Wait 3 seconds for container to stabilize
            return () => clearTimeout(timer);
        }
    }, [noVncUrl]);

    useEffect(() => {
        const video = localVideoRef.current;
        if (video && localStream) {
            video.srcObject = localStream;
            video.play().catch((err) => {
                if (err.name !== "AbortError") {
                    console.error("[Meets] Browser layout local video play error:", err);
                }
            });
        }
    }, [localStream]);

    useEffect(() => {
        const video = browserVideoRef.current;
        if (video && browserVideoStream) {
            video.srcObject = browserVideoStream;
            video.play().catch((err) => {
                if (err.name !== "AbortError") {
                    console.error("[Meets] Browser video play error:", err);
                }
            });
        }
    }, [browserVideoStream]);

    useEffect(() => {
        setNavInput(browserUrl);
    }, [browserUrl]);

    // Extract domain from URL for display
    const displayUrl = (() => {
        try {
            const url = new URL(browserUrl);
            return url.hostname;
        } catch {
            return browserUrl;
        }
    })();

    const resolvedNoVncUrl = resolveNoVncUrl(noVncUrl);

    return (
        <div className="flex flex-1 min-h-0 min-w-0 gap-4 overflow-hidden">
            <div className="flex-1 min-h-0 min-w-0 bg-[#252525] border border-white/5 rounded-lg overflow-hidden relative flex flex-col">
                {isAdmin && onNavigateBrowser && (
                    <div className="px-3 py-2 bg-black/50 border-b border-white/5">
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
                            <Globe className="w-3.5 h-3.5 text-[#FEFCD9]/50 shrink-0" />
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
                                className="flex-1 bg-black/40 border border-[#FEFCD9]/10 rounded-lg px-2.5 py-1.5 text-xs text-[#FEFCD9] placeholder:text-[#FEFCD9]/30 focus:outline-none focus:border-[#FEFCD9]/25"
                            />
                            <button
                                type="submit"
                                disabled={!navInput.trim() || isBrowserLaunching}
                                className="px-3 py-1.5 rounded-lg bg-[#F95F4A] text-white text-xs font-medium hover:bg-[#F95F4A]/90 disabled:opacity-40 disabled:hover:bg-[#F95F4A]"
                            >
                                {isBrowserLaunching ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                    "Go"
                                )}
                            </button>
                        </form>
                        {navError && (
                            <p className="mt-1 text-[11px] text-[#F95F4A]">{navError}</p>
                        )}
                    </div>
                )}
                <div className="flex-1 min-h-0 relative bg-black">
                    {browserVideoStream ? (
                        <>
                            <video
                                ref={browserVideoRef}
                                autoPlay
                                playsInline
                                muted
                                className="absolute inset-0 w-full h-full object-contain bg-black"
                            />
                            {isReady && (
                                <iframe
                                    src={resolvedNoVncUrl}
                                    className="absolute inset-0 w-full h-full border-0 opacity-0"
                                    style={{ pointerEvents: "auto" }}
                                    allow="clipboard-read; clipboard-write"
                                    title="Shared Browser Input"
                                />
                            )}
                        </>
                    ) : isReady ? (
                        <iframe
                            src={resolvedNoVncUrl}
                            className="absolute inset-0 w-full h-full border-0"
                            allow="clipboard-read; clipboard-write"
                            title="Shared Browser"
                        />
                    ) : (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gradient-to-br from-[#1a1a1a] to-[#0d0e0d]">
                            <div className="w-16 h-16 rounded-full bg-[#F95F4A]/10 flex items-center justify-center">
                                <Globe className="w-8 h-8 text-[#F95F4A] animate-pulse" />
                            </div>
                            <div className="flex items-center gap-2">
                                <Loader2 className="w-4 h-4 animate-spin text-[#FEFCD9]/50" />
                                <span className="text-sm text-[#FEFCD9]/40">Starting browser...</span>
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex items-center justify-between px-3 py-2 bg-black/40 border-t border-white/5">
                    <div className="flex items-center gap-2">
                        <div className="w-5 h-5 rounded-full bg-[#F95F4A]/20 flex items-center justify-center">
                            <Globe className="w-2.5 h-2.5 text-[#F95F4A]" />
                        </div>
                        <span
                            className="text-[11px] text-[#FEFCD9]/70 font-medium"
                            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
                        >
                            {displayUrl}
                        </span>
                    </div>
                    <div
                        className="flex items-center gap-2 text-[10px] text-[#FEFCD9]/40"
                        style={{ fontFamily: "'PolySans Mono', monospace" }}
                    >
                        <span className="w-1.5 h-1.5 rounded-full bg-[#4ADE80]"></span>
                        {controllerName} is sharing
                    </div>
                </div>
            </div>

            <div className="w-64 shrink-0 flex flex-col gap-3 overflow-y-auto pr-1">
                <div
                    className={`relative bg-[#252525] border border-white/5 rounded-lg overflow-hidden h-36 shrink-0 transition-all duration-200 ${getSpeakerHighlightClasses(
                        isLocalActiveSpeaker
                    )}`}
                >
                    <video
                        ref={localVideoRef}
                        autoPlay
                        muted
                        playsInline
                        className={`w-full h-full object-cover ${isCameraOff ? "hidden" : ""
                            } ${isMirrorCamera ? "scale-x-[-1]" : ""}`}
                    />
                    {isCameraOff && (
                        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#1a1a1a] to-[#0d0e0d]">
                            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-[#F95F4A]/20 to-[#FF007A]/20 border border-[#FEFCD9]/20 flex items-center justify-center text-lg text-[#FEFCD9] font-bold">
                                {userEmail[0]?.toUpperCase() || "?"}
                            </div>
                        </div>
                    )}
                    {isGhost && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <div className="flex flex-col items-center gap-1.5">
                                <Ghost className="w-12 h-12 text-blue-300 drop-shadow-[0_0_18px_rgba(59,130,246,0.45)]" />
                                <span className="text-[10px] text-blue-200/90 bg-black/60 border border-blue-400/30 px-2 py-0.5 rounded-full">
                                    Ghost
                                </span>
                            </div>
                        </div>
                    )}
                    {isHandRaised && (
                        <div
                            className="absolute top-3 left-3 p-1.5 rounded-full bg-amber-500/20 border border-amber-400/40 text-amber-300 shadow-[0_0_15px_rgba(251,191,36,0.3)]"
                            title="Hand raised"
                        >
                            <Hand className="w-3 h-3" />
                        </div>
                    )}
                    <div
                        className="absolute bottom-3 left-3 bg-black/70 backdrop-blur-sm border border-[#FEFCD9]/10 rounded-full px-3 py-1.5 flex items-center gap-2 text-[10px]"
                        style={{ fontFamily: "'PolySans Mono', monospace" }}
                    >
                        <span className="font-medium text-[#FEFCD9] uppercase tracking-wide">You</span>
                    </div>
                </div>

                {Array.from(participants.values())
                    .filter((participant) => !isSystemUserId(participant.userId))
                    .map((participant) => (
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
