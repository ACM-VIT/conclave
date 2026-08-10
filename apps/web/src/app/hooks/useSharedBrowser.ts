"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";

export interface BrowserState {
    active: boolean;
    url?: string;
    noVncUrl?: string;
    controllerUserId?: string;
    provider?: "chromium" | "kitesurf";
}

type BrowserCommandResponse = {
    success?: boolean;
    noVncUrl?: string;
    provider?: "chromium" | "kitesurf";
    error?: string;
};

interface UseSharedBrowserOptions {
    socketRef: React.MutableRefObject<Socket | null>;
    isAdmin: boolean;
    isConnected: boolean;
}

interface UseSharedBrowserReturn {
    browserState: BrowserState;
    isAvailable: boolean;
    isLaunching: boolean;
    launchError: string | null;
    launchBrowser: (url: string) => Promise<boolean>;
    navigateTo: (url: string) => Promise<boolean>;
    closeBrowser: () => Promise<boolean>;
    clearError: () => void;
}

// Launching Kitesurf can require two sequential Cloudflare requests. The SFU
// caps each request at 20 seconds, so leave enough time for a successful launch
// and its acknowledgement to reach this socket.
const BROWSER_COMMAND_TIMEOUT_MS = 45000;
const BROWSER_CAPABILITIES_TIMEOUT_MS = 22000;

type BrowserCapabilitiesResponse = {
    available?: boolean;
};

const emitBrowserCapabilities = (socket: Socket): Promise<boolean> =>
    new Promise((resolve) => {
        if (!socket.connected) {
            resolve(false);
            return;
        }

        let settled = false;
        const settle = (available: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(available);
        };
        const timeout = setTimeout(() => settle(false), BROWSER_CAPABILITIES_TIMEOUT_MS);
        socket.emit(
            "browser:getCapabilities",
            (response: BrowserCapabilitiesResponse = {}) => settle(response.available === true),
        );
    });

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
    isConnected,
}: UseSharedBrowserOptions): UseSharedBrowserReturn {
    const [browserState, setBrowserState] = useState<BrowserState>({ active: false });
    const [isAvailable, setIsAvailable] = useState(false);
    const [isLaunching, setIsLaunching] = useState(false);
    const [launchError, setLaunchError] = useState<string | null>(null);
    const activityIntervalRef = useRef<NodeJS.Timeout | null>(null);

    const clearError = useCallback(() => {
        setLaunchError(null);
    }, []);

    useEffect(() => {
        const socket = socketRef.current;
        if (!socket || !isAdmin || !isConnected) {
            setIsAvailable(false);
            return;
        }

        let isMounted = true;
        let isChecking = false;
        const refreshCapabilities = async () => {
            if (isChecking) return;
            isChecking = true;
            const available = await emitBrowserCapabilities(socket);
            isChecking = false;
            if (isMounted) setIsAvailable(available);
        };
        const handleDisconnect = () => setIsAvailable(false);

        socket.on("connect", refreshCapabilities);
        socket.on("disconnect", handleDisconnect);
        void refreshCapabilities();
        const interval = setInterval(() => {
            void refreshCapabilities();
        }, 30000);

        return () => {
            isMounted = false;
            clearInterval(interval);
            socket.off("connect", refreshCapabilities);
            socket.off("disconnect", handleDisconnect);
        };
    }, [isAdmin, isConnected, socketRef]);

    useEffect(() => {
        const socket = socketRef.current;
        if (!isConnected) {
            setBrowserState({ active: false });
            setIsLaunching(false);
            return;
        }
        if (!socket) return;

        socket.emit("browser:getState", (state: BrowserState) => {
            setBrowserState(state);
        });
    }, [isConnected, socketRef]);

    useEffect(() => {
        const socket = socketRef.current;
        if (!socket || !isConnected) return;

        const handleBrowserState = (state: BrowserState) => {
            setBrowserState(state);
            setIsLaunching(false);
        };

        const handleBrowserClosed = () => {
            setBrowserState({ active: false });
            setIsLaunching(false);
        };
        const handleDisconnect = () => {
            setBrowserState({ active: false });
            setIsLaunching(false);
        };

        socket.on("browser:state", handleBrowserState);
        socket.on("browser:closed", handleBrowserClosed);
        socket.on("disconnect", handleDisconnect);

        return () => {
            socket.off("browser:state", handleBrowserState);
            socket.off("browser:closed", handleBrowserClosed);
            socket.off("disconnect", handleDisconnect);
        };
    }, [isConnected, socketRef]);

    useEffect(() => {
        const socket = socketRef.current;
        if (!socket || !isConnected || !browserState.active || !isAdmin) {
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
    }, [browserState.active, isAdmin, isConnected, socketRef]);

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
                provider: response.provider,
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
        isAvailable,
        isLaunching,
        launchError,
        launchBrowser,
        navigateTo,
        closeBrowser,
        clearError,
    };
}
