"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Participant } from "../lib/types";

interface UseMeetPictureInPictureOptions {
    isJoined: boolean;
    localStream: MediaStream | null;
    participants: Map<string, Participant>;
    activeSpeakerId: string | null;
    presentationStream: MediaStream | null;
    presenterName: string;
    currentUserId: string;
    isCameraOff: boolean;
    userEmail: string;
    getDisplayName: (userId: string) => string;
}

interface PictureInPictureState {
    isPiPActive: boolean;
    isPiPSupported: boolean;
    canEnterPiP: boolean;
    enterPiP: () => Promise<void>;
    exitPiP: () => Promise<void>;
}

export function useMeetPictureInPicture({
    isJoined,
    localStream,
    participants,
    activeSpeakerId,
    presentationStream,
    presenterName,
    currentUserId,
    isCameraOff,
    userEmail,
    getDisplayName,
}: UseMeetPictureInPictureOptions): PictureInPictureState {
    const [isPiPActive, setIsPiPActive] = useState(false);
    const [isPiPSupported, setIsPiPSupported] = useState(false);

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const animationFrameRef = useRef<number | null>(null);
    const pipWindowRef = useRef<PictureInPictureWindow | null>(null);
    const manualExitRef = useRef(false);
    const lastRemoteSpeakerRef = useRef<string | null>(null);

    useEffect(() => {
        if (activeSpeakerId && activeSpeakerId !== currentUserId) {
            lastRemoteSpeakerRef.current = activeSpeakerId;
        }
    }, [activeSpeakerId, currentUserId]);

    // Check PiP support on mount
    // Disable legacy canvas PiP if Document PiP is available (the new popout is better)
    useEffect(() => {
        const hasDocumentPiP =
            typeof window !== "undefined" && "documentPictureInPicture" in window;
        const supported =
            !hasDocumentPiP &&
            typeof document !== "undefined" &&
            "pictureInPictureEnabled" in document &&
            document.pictureInPictureEnabled;
        setIsPiPSupported(supported);
    }, []);

    // Get the current video source to display
    const getVideoSource = useCallback((): { stream: MediaStream | null; name: string } => {
        // Priority 1: Presentation/screen share
        if (presentationStream) {
            return { stream: presentationStream, name: presenterName };
        }

        // Priority 2: Active speaker (prefer remote)
        if (activeSpeakerId && activeSpeakerId !== currentUserId) {
            const speakerParticipant = participants.get(activeSpeakerId);
            return {
                stream: speakerParticipant?.videoStream ?? null,
                name: getDisplayName(activeSpeakerId),
            };
        }

        // Priority 3: Last remote speaker (fallback when local is active)
        if (lastRemoteSpeakerRef.current) {
            const lastSpeakerId = lastRemoteSpeakerRef.current;
            if (lastSpeakerId !== currentUserId) {
                const lastSpeaker = participants.get(lastSpeakerId);
                return {
                    stream: lastSpeaker?.videoStream ?? null,
                    name: getDisplayName(lastSpeakerId),
                };
            }
        }

        // Priority 4: First remote participant with video
        for (const [userId, participant] of participants) {
            if (userId === currentUserId) continue;
            if (participant.videoStream && !participant.isCameraOff) {
                return { stream: participant.videoStream, name: getDisplayName(userId) };
            }
        }

        // Priority 5: Any remote participant (even without video)
        for (const [userId] of participants) {
            if (userId === currentUserId) continue;
            return { stream: null, name: getDisplayName(userId) };
        }

        // Priority 6: Local stream (self)
        if (localStream && !isCameraOff) {
            return { stream: localStream, name: "You" };
        }

        return { stream: null, name: "" };
    }, [
        presentationStream,
        presenterName,
        activeSpeakerId,
        currentUserId,
        participants,
        localStream,
        isCameraOff,
        getDisplayName,
    ]);

    const canEnterPiP = isPiPSupported && isJoined;

    // Render video to canvas with name overlay
    const renderFrame = useCallback(() => {
        const canvas = canvasRef.current;
        const video = videoRef.current;
        const ctx = canvas?.getContext("2d");

        if (!canvas || !video || !ctx) {
            animationFrameRef.current = requestAnimationFrame(renderFrame);
            return;
        }

        const { stream, name } = getVideoSource();

        if (stream) {
            if (video.srcObject !== stream) {
                video.srcObject = stream;
                video.play().catch(() => { });
            }
        } else if (video.srcObject) {
            video.srcObject = null;
        }

        // Draw video frame
        if (video.readyState >= 2) {
            // Maintain aspect ratio
            const videoAspect = video.videoWidth / video.videoHeight;
            const canvasAspect = canvas.width / canvas.height;

            let drawWidth = canvas.width;
            let drawHeight = canvas.height;
            let offsetX = 0;
            let offsetY = 0;

            if (videoAspect > canvasAspect) {
                drawHeight = canvas.width / videoAspect;
                offsetY = (canvas.height - drawHeight) / 2;
            } else {
                drawWidth = canvas.height * videoAspect;
                offsetX = (canvas.width - drawWidth) / 2;
            }

            ctx.fillStyle = "#0d0e0d";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);

            // Draw name overlay
            if (name) {
                const padding = 8;
                const fontSize = 14;
                ctx.font = `500 ${fontSize}px sans-serif`;
                const textWidth = ctx.measureText(name).width;

                // Background pill
                ctx.fillStyle = "rgba(13, 14, 13, 0.8)";
                const pillHeight = fontSize + padding * 2;
                const pillWidth = textWidth + padding * 2;
                const pillX = padding;
                const pillY = canvas.height - pillHeight - padding;

                ctx.beginPath();
                ctx.roundRect(pillX, pillY, pillWidth, pillHeight, pillHeight / 2);
                ctx.fill();

                // Text
                ctx.fillStyle = "#FEFCD9";
                ctx.fillText(name, pillX + padding, pillY + fontSize + padding / 2);
            }
        } else {
            // No video - show placeholder
            ctx.fillStyle = "#0d0e0d";
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Draw circle with initial
            const centerX = canvas.width / 2;
            const centerY = canvas.height / 2;
            const radius = 40;

            ctx.beginPath();
            ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(249, 95, 74, 0.2)";
            ctx.fill();
            ctx.strokeStyle = "rgba(254, 252, 217, 0.2)";
            ctx.lineWidth = 2;
            ctx.stroke();

            // Initial letter
            const initial = (name || userEmail || "?")[0]?.toUpperCase() || "?";
            ctx.fillStyle = "#FEFCD9";
            ctx.font = "bold 32px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(initial, centerX, centerY);
            ctx.textAlign = "start";
        }

        animationFrameRef.current = requestAnimationFrame(renderFrame);
    }, [getVideoSource, userEmail]);

    // Enter PiP mode
    const enterPiP = useCallback(async () => {
        if (!isPiPSupported || !isJoined || isPiPActive) return;

        manualExitRef.current = false;

        try {
            // Create canvas if not exists
            if (!canvasRef.current) {
                const canvas = document.createElement("canvas");
                canvas.width = 320;
                canvas.height = 180;
                canvasRef.current = canvas;
            }

            // Create hidden video element for source
            if (!videoRef.current) {
                const video = document.createElement("video");
                video.muted = true;
                video.playsInline = true;
                videoRef.current = video;
            }

            // Start rendering
            if (animationFrameRef.current === null) {
                animationFrameRef.current = requestAnimationFrame(renderFrame);
            }

            // Create a video element from canvas stream
            const canvasStream = canvasRef.current.captureStream(30);
            const pipVideo = document.createElement("video");
            pipVideo.srcObject = canvasStream;
            pipVideo.muted = true;
            pipVideo.playsInline = true;

            // Need to add to DOM briefly for PiP to work in some browsers
            pipVideo.style.position = "fixed";
            pipVideo.style.opacity = "0";
            pipVideo.style.pointerEvents = "none";
            pipVideo.style.width = "1px";
            pipVideo.style.height = "1px";
            document.body.appendChild(pipVideo);

            await pipVideo.play();

            const pipWindow = await pipVideo.requestPictureInPicture();
            pipWindowRef.current = pipWindow;
            setIsPiPActive(true);

            pipWindow.addEventListener("resize", () => {
                if (canvasRef.current) {
                    canvasRef.current.width = pipWindow.width;
                    canvasRef.current.height = pipWindow.height;
                }
            });

            pipVideo.addEventListener("leavepictureinpicture", () => {
                setIsPiPActive(false);
                pipWindowRef.current = null;
                manualExitRef.current = true;

                // Clean up
                if (animationFrameRef.current !== null) {
                    cancelAnimationFrame(animationFrameRef.current);
                    animationFrameRef.current = null;
                }

                pipVideo.remove();
            });

        } catch (err) {
            console.warn("[PiP] Failed to enter Picture-in-Picture:", err);
        }
    }, [isPiPSupported, isJoined, isPiPActive, renderFrame]);

    // Exit PiP mode
    const exitPiP = useCallback(async () => {
        if (!isPiPActive) return;

        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            }
        } catch (err) {
            console.warn("[PiP] Failed to exit Picture-in-Picture:", err);
        }

        setIsPiPActive(false);
        pipWindowRef.current = null;
    }, [isPiPActive]);

    // Auto-enter PiP when tab becomes hidden
    useEffect(() => {
        if (!isPiPSupported || !isJoined) return;

        const handleVisibilityChange = () => {
            if (document.hidden && !isPiPActive && !manualExitRef.current) {
                enterPiP();
            } else if (!document.hidden && isPiPActive) {
                exitPiP();
            }
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => {
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [isPiPSupported, isJoined, isPiPActive, enterPiP, exitPiP]);

    // Cleanup on unmount or when leaving room
    useEffect(() => {
        return () => {
            if (animationFrameRef.current !== null) {
                cancelAnimationFrame(animationFrameRef.current);
            }
            if (document.pictureInPictureElement) {
                document.exitPictureInPicture().catch(() => { });
            }
        };
    }, []);

    // Exit PiP when leaving room
    useEffect(() => {
        if (!isJoined && isPiPActive) {
            exitPiP();
        }
    }, [isJoined, isPiPActive, exitPiP]);

    return {
        isPiPActive,
        isPiPSupported,
        canEnterPiP,
        enterPiP,
        exitPiP,
    };
}
