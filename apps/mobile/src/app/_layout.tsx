import React, { useEffect } from "react";
import "../global.css";
import { Stack } from "expo-router";
import { LogBox } from 'react-native';
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";

LogBox.ignoreAllLogs(false);
LogBox.ignoreLogs([
  "SafeAreaView has been deprecated and will be removed in a future release. Please use 'react-native-safe-area-context' instead.",
]);

SplashScreen.preventAutoHideAsync();

ErrorUtils.setGlobalHandler((error, isFatal) => {
  console.error("Caught global error:", error, isFatal);
});

export default function Layout() {
  const [fontsLoaded, fontError] = useFonts({
    "PolySans-BulkyWide": require("../../assets/fonts/PolySansTrial-BulkyWide.otf"),
    "PolySans-Bulky": require("../../assets/fonts/PolySansTrial-Bulky.otf"),
    "PolySans-Mono": require("../../assets/fonts/PolySansTrial-NeutralMono.otf"),
    "PolySans-Regular": require("../../assets/fonts/PolySansTrial-Neutral.otf"),
    "PolySans-Median": require("../../assets/fonts/PolySansTrial-Median.otf"),
    "PolySans-Slim": require("../../assets/fonts/PolySansTrial-Slim.otf"),
  });

  useEffect(() => {
    if (fontError) {
      console.warn("[Fonts] Failed to load custom fonts", fontError);
    }
  }, [fontError]);

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync();
    } else {
      const fallback = setTimeout(() => {
        SplashScreen.hideAsync();
      }, 1500);
      return () => clearTimeout(fallback);
    }
  }, [fontsLoaded]);

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: "#060606" },
      }}
    />
  );
}
