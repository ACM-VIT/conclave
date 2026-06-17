"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";

export interface BrowserState {
    active: boolean;
    url?: string;
    noVncUrl?: string;
    controllerUserId?: string;
}

type BrowserCommandResponse = {
    success?: boolean;
    noVncUrl?: string;
    error?: string;
};

interface UseSharedBrowserOptions {
    socketRef: React.MutableRefObject<Socket | null>;
    isAdmin: boolean;
}

interface UseSharedBrowserReturn {
    browserState: BrowserState;
    isLaunching: boolean;
    launchError: string | null;
    launchBrowser: (url: string) => Promise<boolean>;
    navigateTo: (url: string) => Promise<boolean>;
    closeBrowser: () => Promise<boolean>;
    clearError: () => void;
}

const BROWSER_COMMAND_TIMEOUT_MS = 15000;

const emitBrowserCommand = (
    socket: Socket,
    event: "browser:launch" | "browser:navigate" | "browser:close",
    payload?: { url: string },
): Promise<BrowserCommandResponse> => {
    return new Promise((resolve) => {
        if (!socket.connected) {
            resolve({ error: "Shared browser socket is disconnected." });
            return;
        }

        let settled = false;
        const settle = (response: BrowserCommandResponse) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            socket.off("disconnect", handleDisconnect);
            resolve(response);
        };
        const handleDisconnect = () => {
            settle({ error: "Shared browser socket disconnected before the command completed." });
        };
        const timeout = setTimeout(() => {
            settle({ error: "Shared browser command timed out." });
        }, BROWSER_COMMAND_TIMEOUT_MS);

        socket.once("disconnect", handleDisconnect);
        if (payload) {
            socket.emit(event, payload, (response: BrowserCommandResponse = {}) => {
                settle(response);
            });
        } else {
            socket.emit(event, (response: BrowserCommandResponse = {}) => {
                settle(response);
            });
        }
    });
};

export function useSharedBrowser({
    socketRef,
    isAdmin,
}: UseSharedBrowserOptions): UseSharedBrowserReturn {
    const [browserState, setBrowserState] = useState<BrowserState>({ active: false });
    const [isLaunching, setIsLaunching] = useState(false);
    const [launchError, setLaunchError] = useState<string | null>(null);
    const activityIntervalRef = useRef<NodeJS.Timeout | null>(null);

    const clearError = useCallback(() => {
        setLaunchError(null);
    }, []);

    useEffect(() => {
        const socket = socketRef.current;
        if (!socket) return;

        socket.emit("browser:getState", (state: BrowserState) => {
            setBrowserState(state);
        });
    }, [socketRef]);

    useEffect(() => {
        const socket = socketRef.current;
        if (!socket) return;

        const handleBrowserState = (state: BrowserState) => {
            setBrowserState(state);
            setIsLaunching(false);
        };

        const handleBrowserClosed = () => {
            setBrowserState({ active: false });
            setIsLaunching(false);
        };

        socket.on("browser:state", handleBrowserState);
        socket.on("browser:closed", handleBrowserClosed);

        return () => {
            socket.off("browser:state", handleBrowserState);
            socket.off("browser:closed", handleBrowserClosed);
        };
    }, [socketRef]);

    useEffect(() => {
        const socket = socketRef.current;
        if (!socket || !browserState.active) {
            if (activityIntervalRef.current) {
                clearInterval(activityIntervalRef.current);
                activityIntervalRef.current = null;
            }
            return;
        }

        activityIntervalRef.current = setInterval(() => {
            socket.emit("browser:activity");
        }, 30000);

        return () => {
            if (activityIntervalRef.current) {
                clearInterval(activityIntervalRef.current);
                activityIntervalRef.current = null;
            }
        };
    }, [browserState.active, socketRef]);

    const launchBrowser = useCallback(
        async (url: string): Promise<boolean> => {
            const socket = socketRef.current;
            if (!socket || !isAdmin) return false;

            setIsLaunching(true);
            setLaunchError(null);

            const response = await emitBrowserCommand(socket, "browser:launch", { url });
            setIsLaunching(false);
            if (response.error) {
                setLaunchError(response.error);
                return false;
            }

            setBrowserState({
                active: true,
                url,
                noVncUrl: response.noVncUrl,
            });
            return true;
        },
        [socketRef, isAdmin]
    );

    const navigateTo = useCallback(
        async (url: string): Promise<boolean> => {
            const socket = socketRef.current;
            if (!socket || !isAdmin) return false;

            setIsLaunching(true);
            setLaunchError(null);

            const response = await emitBrowserCommand(socket, "browser:navigate", { url });
            setIsLaunching(false);
            if (response.error) {
                setLaunchError(response.error);
                return false;
            }

            setBrowserState((prev) => ({
                ...prev,
                url,
                noVncUrl: response.noVncUrl,
            }));
            return true;
        },
        [socketRef, isAdmin]
    );

    const closeBrowser = useCallback(async (): Promise<boolean> => {
        const socket = socketRef.current;
        if (!socket || !isAdmin) return false;

        const response = await emitBrowserCommand(socket, "browser:close");
        if (response.error) {
            setLaunchError(response.error);
            return false;
        }

        setBrowserState({ active: false });
        return true;
    }, [socketRef, isAdmin]);

    return {
        browserState,
        isLaunching,
        launchError,
        launchBrowser,
        navigateTo,
        closeBrowser,
        clearError,
    };
}
