import React from "react";
import { cssInterop, useUnstableNativeVariable as useNativeVariable } from "nativewind";
import { Link as RouterLink } from "expo-router";
import Animated from "react-native-reanimated";
import {
  View as RNView,
  Text as RNText,
  Pressable as RNPressable,
  ScrollView as RNScrollView,
  TouchableHighlight as RNTouchableHighlight,
  TouchableOpacity as RNTouchableOpacity,
  TextInput as RNTextInput,
  FlatList as RNFlatList,
  StyleSheet,
} from "react-native";
import { SafeAreaView as RNSafeAreaView } from "react-native-safe-area-context";

const StyledRouterLink = cssInterop(RouterLink, { className: "style" });
export const Link = (
  props: React.ComponentProps<typeof RouterLink> & { className?: string },
) => {
  return <StyledRouterLink {...props} />;
};

Link.Trigger = RouterLink.Trigger;
Link.Menu = RouterLink.Menu;
Link.MenuAction = RouterLink.MenuAction;
Link.Preview = RouterLink.Preview;

export const useCSSVariable =
  process.env.EXPO_OS !== "web"
    ? useNativeVariable
    : (variable: string) => `var(${variable})`;

export const View = RNView;
export const Text = RNText;
export const ScrollView = RNScrollView;
export const Pressable = RNPressable;
export const TouchableOpacity = RNTouchableOpacity;
export const TextInput = RNTextInput;
export const FlatList = RNFlatList;

export const AnimatedView = cssInterop(Animated.View, { className: "style" });
export const AnimatedScrollView = cssInterop(Animated.ScrollView, {
  className: "style",
  contentContainerClassName: "contentContainerStyle",
});
export const AnimatedText = cssInterop(Animated.Text, { className: "style" });

function XXTouchableHighlight(
  props: React.ComponentProps<typeof RNTouchableHighlight>,
) {
  const flattened = StyleSheet.flatten(props.style) as
    | (Record<string, unknown> & { underlayColor?: string })
    | undefined;
  const { underlayColor, ...style } = flattened || {};
  return (
    <RNTouchableHighlight
      underlayColor={underlayColor}
      {...props}
      style={style}
    />
  );
}

export const TouchableHighlight = cssInterop(XXTouchableHighlight, {
  className: "style",
});

// SafeAreaView
export const SafeAreaView = cssInterop(RNSafeAreaView, { className: "style" });

export { Image, ImageProps } from "./image";
