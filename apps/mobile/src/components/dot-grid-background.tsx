import React from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { Image } from "@/tw";
import BackgroundPattern from "../../assets/background_pattern.png";

interface DotGridBackgroundProps {
    children: React.ReactNode;
}

export function DotGridBackground({ children }: DotGridBackgroundProps) {
    return (
        <View style={styles.container}>
            <View style={styles.radialContainer} pointerEvents="none">
                <Svg width="100%" height="100%">
                    <Defs>
                        <RadialGradient id="radialOrange" cx="30%" cy="20%" r="60%">
                            <Stop offset="0%" stopColor="#F95F4A" stopOpacity={0.12} />
                            <Stop offset="50%" stopColor="#F95F4A" stopOpacity={0} />
                        </RadialGradient>
                        <RadialGradient id="radialPink" cx="70%" cy="80%" r="60%">
                            <Stop offset="0%" stopColor="#FF007A" stopOpacity={0.09} />
                            <Stop offset="50%" stopColor="#FF007A" stopOpacity={0} />
                        </RadialGradient>
                    </Defs>
                    <Rect width="100%" height="100%" fill="url(#radialOrange)" />
                    <Rect width="100%" height="100%" fill="url(#radialPink)" />
                </Svg>
            </View>
            <View style={styles.patternContainer} pointerEvents="none">
                <Image
                    source={BackgroundPattern}
                    style={styles.patternImage}
                    contentFit="cover"
                />
            </View>
            <View style={styles.content}>{children}</View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: "#131316",
        width: "100%",
    },
    radialContainer: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 0,
    },
    patternContainer: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 1,
    },
    patternImage: {
        ...StyleSheet.absoluteFillObject,
        opacity: 1,
    },
    content: {
        flex: 1,
        zIndex: 2,
    },
});
