import { useMemo } from "react";
import { useWindowDimensions } from "react-native";

export type DeviceLayout = "compact" | "regular" | "large";

export const BREAKPOINTS = {
    REGULAR: 768,
    LARGE: 1024,
} as const;

export const TOUCH_TARGETS = {
    MIN: 44,
    COMFORTABLE: 48,
    LARGE: 56,
} as const;

export const SPACING = {
    compact: {
        xs: 4,
        sm: 8,
        md: 12,
        lg: 16,
        xl: 24,
    },
    regular: {
        xs: 6,
        sm: 10,
        md: 16,
        lg: 24,
        xl: 32,
    },
    large: {
        xs: 8,
        sm: 12,
        md: 20,
        lg: 32,
        xl: 48,
    },
} as const;

export interface DeviceLayoutInfo {
    layout: DeviceLayout;
    isLandscape: boolean;
    width: number;
    height: number;
    isTablet: boolean;
    touchTargetSize: number;
    spacing: (typeof SPACING)[DeviceLayout];
}

export function useDeviceLayout(): DeviceLayoutInfo {
    const { width, height } = useWindowDimensions();

    return useMemo(() => {
        const isLandscape = width > height;

        let layout: DeviceLayout;
        if (width >= BREAKPOINTS.LARGE) {
            layout = "large";
        } else if (width >= BREAKPOINTS.REGULAR) {
            layout = "regular";
        } else {
            layout = "compact";
        }

        const isTablet = layout !== "compact";

        const touchTargetSize = isTablet ? TOUCH_TARGETS.COMFORTABLE : TOUCH_TARGETS.MIN;

        const spacing = SPACING[layout];

        return {
            layout,
            isLandscape,
            width,
            height,
            isTablet,
            touchTargetSize,
            spacing,
        };
    }, [width, height]);
}

export function getGridColumns(participantCount: number, layout: DeviceLayout): number {
    if (layout === "large") {
        if (participantCount <= 2) return 2;
        if (participantCount <= 4) return 2;
        if (participantCount <= 6) return 3;
        return 4;
    }

    if (layout === "regular") {
        if (participantCount <= 2) return 2;
        if (participantCount <= 4) return 2;
        if (participantCount <= 6) return 3;
        return 3;
    }

    if (participantCount <= 3) return 1;
    if (participantCount <= 6) return 2;
    if (participantCount <= 9) return 3;
    return 3;
}

export function getPanelWidth(
    layout: DeviceLayout,
    panelType: "chat" | "participants"
): { width: number | string; maxWidth: number } {
    if (layout === "compact") {
        return { width: "100%", maxWidth: 9999 };
    }

    const maxWidth = panelType === "chat" ? 420 : 380;
    return { width: maxWidth, maxWidth };
}
