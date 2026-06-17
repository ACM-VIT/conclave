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
    const pipVideoRef = useRef<HTMLVideoElement | null>(null);
    const canvasStreamRef = useRef<MediaStream | null>(null);
    const animationFrameRef = useRef<number | null>(null);
    const pipWindowRef = useRef<PictureInPictureWindow | null>(null);
    const pipWindowResizeHandlerRef = useRef<(() => void) | null>(null);
    const pipLeaveHandlerRef = useRef<(() => void) | null>(null);
    const avatarImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
    const manualExitRef = useRef(false);
    const lastRemoteSpeakerRef = useRef<string | null>(null);

    useEffect(() => {
        if (activeSpeakerId && activeSpeakerId !== currentUserId) {
            lastRemoteSpeakerRef.current = activeSpeakerId;
        }
    }, [activeSpeakerId, currentUserId]);

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

    const getVideoSource = useCallback((): { stream: MediaStream | null; name: string } => {
        if (presentationStream) {
            return { stream: presentationStream, name: presenterName };
        }

        if (activeSpeakerId && activeSpeakerId !== currentUserId) {
            const speakerParticipant = participants.get(activeSpeakerId);
            return {
                stream: speakerParticipant?.videoStream ?? null,
                name: getDisplayName(activeSpeakerId),
            };
        }

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

        for (const [userId, participant] of participants) {
            if (userId === currentUserId) continue;
            if (participant.videoStream && !participant.isCameraOff) {
                return { stream: participant.videoStream, name: getDisplayName(userId) };
            }
        }

        for (const [userId] of participants) {
            if (userId === currentUserId) continue;
            return { stream: null, name: getDisplayName(userId) };
        }

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

    const getAvatarImage = useCallback((name: string) => {
        if (typeof Image === "undefined") return null;

        const src = avatarUrl(name || userEmail);
        let image = avatarImagesRef.current.get(src);

        if (!image) {
            image = new Image();
            image.decoding = "async";
            image.src = src;
            avatarImagesRef.current.set(src, image);
        }

        return image.complete && image.naturalWidth > 0 ? image : null;
    }, [userEmail]);

    const canEnterPiP = isPiPSupported && isJoined;

    const stopRenderLoop = useCallback(() => {
        if (animationFrameRef.current !== null) {
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
        }
    }, []);

    const cleanupPiPResources = useCallback(() => {
        stopRenderLoop();

        if (videoRef.current?.srcObject) {
            videoRef.current.srcObject = null;
        }

        if (pipWindowRef.current && pipWindowResizeHandlerRef.current) {
            pipWindowRef.current.removeEventListener(
                "resize",
                pipWindowResizeHandlerRef.current,
            );
            pipWindowResizeHandlerRef.current = null;
        }

        if (pipVideoRef.current) {
            if (pipLeaveHandlerRef.current) {
                pipVideoRef.current.removeEventListener(
                    "leavepictureinpicture",
                    pipLeaveHandlerRef.current,
                );
                pipLeaveHandlerRef.current = null;
            }
            pipVideoRef.current.srcObject = null;
            pipVideoRef.current.remove();
            pipVideoRef.current = null;
        }

        if (canvasStreamRef.current) {
            canvasStreamRef.current.getTracks().forEach((track) => track.stop());
            canvasStreamRef.current = null;
        }

        pipWindowRef.current = null;
    }, [stopRenderLoop]);

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

        if (video.readyState >= 2) {
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

            ctx.fillStyle = "#131316";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);

            if (name) {
                const padding = 8;
                const fontSize = 14;
                ctx.font = `500 ${fontSize}px sans-serif`;
                const textWidth = ctx.measureText(name).width;

                ctx.fillStyle = "rgba(13, 14, 13, 0.8)";
                const pillHeight = fontSize + padding * 2;
                const pillWidth = textWidth + padding * 2;
                const pillX = padding;
                const pillY = canvas.height - pillHeight - padding;

                ctx.beginPath();
                ctx.roundRect(pillX, pillY, pillWidth, pillHeight, pillHeight / 2);
                ctx.fill();

                ctx.fillStyle = "#fafafa";
                ctx.fillText(name, pillX + padding, pillY + fontSize + padding / 2);
            }
        } else {
            ctx.fillStyle = "#131316";
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            const centerX = canvas.width / 2;
            const centerY = canvas.height / 2;
            const radius = 40;
            const avatarImage = getAvatarImage(name || userEmail);

            ctx.beginPath();
            ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
            ctx.save();
            ctx.clip();

            if (avatarImage) {
                ctx.drawImage(
                    avatarImage,
                    centerX - radius,
                    centerY - radius,
                    radius * 2,
                    radius * 2,
                );
            } else {
                ctx.fillStyle = "#F95F4A";
                ctx.fillRect(centerX - radius, centerY - radius, radius * 2, radius * 2);
                ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
                ctx.beginPath();
                ctx.arc(centerX - 14, centerY - 8, 6, 0, Math.PI * 2);
                ctx.arc(centerX + 14, centerY - 8, 6, 0, Math.PI * 2);
                ctx.fill();
                ctx.lineWidth = 4;
                ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
                ctx.beginPath();
                ctx.arc(centerX, centerY + 4, 14, 0.15 * Math.PI, 0.85 * Math.PI);
                ctx.stroke();
            }

            ctx.restore();
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(250, 250, 250, 0.2)";
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        animationFrameRef.current = requestAnimationFrame(renderFrame);
    }, [getAvatarImage, getVideoSource, userEmail]);

    const enterPiP = useCallback(async () => {
        if (!isPiPSupported || !isJoined || isPiPActive) return;

        manualExitRef.current = false;

        try {
            if (!canvasRef.current) {
                const canvas = document.createElement("canvas");
                canvas.width = 320;
                canvas.height = 180;
                canvasRef.current = canvas;
            }

            if (!videoRef.current) {
                const video = document.createElement("video");
                video.muted = true;
                video.playsInline = true;
                videoRef.current = video;
            }

            if (animationFrameRef.current === null) {
                animationFrameRef.current = requestAnimationFrame(renderFrame);
            }

            const canvasStream = canvasRef.current.captureStream(30);
            canvasStreamRef.current = canvasStream;
            const pipVideo = document.createElement("video");
            pipVideoRef.current = pipVideo;
            pipVideo.srcObject = canvasStream;
            pipVideo.muted = true;
            pipVideo.playsInline = true;

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

            const handleResize = () => {
                if (canvasRef.current) {
                    canvasRef.current.width = pipWindow.width;
                    canvasRef.current.height = pipWindow.height;
                }
            };
            pipWindowResizeHandlerRef.current = handleResize;
            pipWindow.addEventListener("resize", handleResize);

            const handleLeavePictureInPicture = () => {
                setIsPiPActive(false);
                manualExitRef.current = true;
                cleanupPiPResources();
            };
            pipLeaveHandlerRef.current = handleLeavePictureInPicture;
            pipVideo.addEventListener(
                "leavepictureinpicture",
                handleLeavePictureInPicture,
            );

        } catch (err) {
            cleanupPiPResources();
            console.warn("[PiP] Failed to enter Picture-in-Picture:", err);
        }
    }, [
        isPiPSupported,
        isJoined,
        isPiPActive,
        renderFrame,
        cleanupPiPResources,
    ]);

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
        cleanupPiPResources();
    }, [isPiPActive, cleanupPiPResources]);

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

    useEffect(() => {
        return () => {
            cleanupPiPResources();
            if (document.pictureInPictureElement) {
                document.exitPictureInPicture().catch(() => { });
            }
        };
    }, [cleanupPiPResources]);

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

function avatarUrl(name: string) {
    const params = new URLSearchParams({
        format: "svg",
        name: name || "?",
        showInitial: "false",
        size: "96",
    });
    return `/api/avatar?${params.toString()}`;
}
