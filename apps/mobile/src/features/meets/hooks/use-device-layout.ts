import { useMemo } from "react";
import { useWindowDimensions } from "react-native";

/**
 * Device layout types following Apple HIG breakpoints:
 * - compact: iPhone (< 768pt width)
 * - regular: iPad portrait or small iPad landscape (768-1023pt)
 * - large: iPad landscape (>= 1024pt)
 */
export type DeviceLayout = "compact" | "regular" | "large";

/**
 * Breakpoints based on Apple Human Interface Guidelines
 * iPad mini: 744pt portrait, 1133pt landscape
 * iPad: 768pt portrait, 1024pt landscape
 * iPad Pro 11": 834pt portrait, 1194pt landscape
 * iPad Pro 12.9": 1024pt portrait, 1366pt landscape
 */
export const BREAKPOINTS = {
    /** iPad portrait starts at 768pt */
    REGULAR: 768,
    /** iPad landscape typically starts at 1024pt */
    LARGE: 1024,
} as const;

/**
 * Touch target sizes per Apple HIG
 * Minimum: 44×44pt
 * Recommended for iPad: 48×48pt
 */
export const TOUCH_TARGETS = {
    /** Minimum tap target per Apple HIG */
    MIN: 44,
    /** Recommended for larger screens */
    COMFORTABLE: 48,
    /** For primary actions */
    LARGE: 56,
} as const;

/**
 * Spacing values that scale with screen size
 */
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
    /** Current device layout category */
    layout: DeviceLayout;
    /** Whether device is in landscape orientation */
    isLandscape: boolean;
    /** Current screen width in points */
    width: number;
    /** Current screen height in points */
    height: number;
    /** Whether this is an iPad-class device */
    isTablet: boolean;
    /** Appropriate touch target size for current layout */
    touchTargetSize: number;
    /** Spacing values for current layout */
    spacing: (typeof SPACING)[DeviceLayout];
}

/**
 * Hook to detect device layout for responsive design.
 * Returns layout information based on screen dimensions following Apple HIG.
 *
 * @example
 * ```tsx
 * const { layout, isTablet, spacing } = useDeviceLayout();
 *
 * // Use layout for conditional rendering
 * if (layout === 'large') {
 *   // iPad landscape two-column layout
 * }
 *
 * // Use spacing for consistent gaps
 * <View style={{ gap: spacing.md }} />
 * ```
 */
export function useDeviceLayout(): DeviceLayoutInfo {
    const { width, height } = useWindowDimensions();

    return useMemo(() => {
        const isLandscape = width > height;

        // Determine layout based on width
        let layout: DeviceLayout;
        if (width >= BREAKPOINTS.LARGE) {
            layout = "large";
        } else if (width >= BREAKPOINTS.REGULAR) {
            layout = "regular";
        } else {
            layout = "compact";
        }

        const isTablet = layout !== "compact";

        // Touch target size scales with layout
        const touchTargetSize = isTablet ? TOUCH_TARGETS.COMFORTABLE : TOUCH_TARGETS.MIN;

        // Get spacing for current layout
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

/**
 * Get the optimal number of grid columns for a participant count
 * @param participantCount Number of participants
 * @param layout Current device layout
 */
export function getGridColumns(participantCount: number, layout: DeviceLayout): number {
    if (layout === "large") {
        // iPad landscape - more columns
        if (participantCount <= 2) return 2;
        if (participantCount <= 4) return 2;
        if (participantCount <= 6) return 3;
        return 4;
    }

    if (layout === "regular") {
        // iPad portrait - balanced columns
        if (participantCount <= 2) return 2;
        if (participantCount <= 4) return 2;
        if (participantCount <= 6) return 3;
        return 3;
    }

    // Compact (iPhone) - fewer columns
    if (participantCount <= 3) return 1;
    if (participantCount <= 6) return 2;
    if (participantCount <= 9) return 3;
    return 3;
}

/**
 * Get panel width constraints for sidebars on iPad
 * @param layout Current device layout
 * @param panelType Type of panel
 */
export function getPanelWidth(
    layout: DeviceLayout,
    panelType: "chat" | "participants"
): { width: number | string; maxWidth: number } {
    if (layout === "compact") {
        return { width: "100%", maxWidth: 9999 };
    }

    // iPad - constrain to sidebar width
    const maxWidth = panelType === "chat" ? 420 : 380;
    return { width: maxWidth, maxWidth };
}
