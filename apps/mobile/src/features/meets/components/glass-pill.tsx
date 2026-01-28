import React, { useCallback, useState } from "react";
import {
  LayoutChangeEvent,
  Platform,
  StyleProp,
  StyleSheet,
  View as RNView,
  ViewStyle,
} from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { Capsule, GlassEffectContainer, Host } from "@expo/ui/swift-ui";
import { frame, glassEffect } from "@expo/ui/swift-ui/modifiers";

interface GlassPillBackgroundProps {
  width: number;
  height: number;
}

interface GlassPillProps {
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

const isIos = Platform.OS === "ios";

export function GlassPillBackground({
  width,
  height,
}: GlassPillBackgroundProps) {
  if (!isIos) return null;

  const canUseSwiftGlass = isLiquidGlassAvailable();

  if (canUseSwiftGlass) {
    return (
      <RNView pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Host style={StyleSheet.absoluteFill}>
          <GlassEffectContainer>
            <Capsule
              modifiers={[
                frame({ width, height }),
                glassEffect({
                  glass: {
                    variant: "clear",
                  },
                  shape: "capsule",
                }),
              ]}
            />
          </GlassEffectContainer>
        </Host>
      </RNView>
    );
  }

  return (
    <RNView pointerEvents="none" style={StyleSheet.absoluteFill}>
      <GlassView
        glassEffectStyle="clear"
        style={[StyleSheet.absoluteFill, { borderRadius: height / 2 }]}
      />
    </RNView>
  );
}

export function GlassPill({ style, children }: GlassPillProps) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      if (width !== size.width || height !== size.height) {
        setSize({ width, height });
      }
    },
    [size.height, size.width]
  );

  return (
    <RNView onLayout={handleLayout} style={[styles.container, style]}>
      {size.width > 0 && size.height > 0 ? (
        <GlassPillBackground width={size.width} height={size.height} />
      ) : null}
      {children}
    </RNView>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: "hidden",
  },
});
