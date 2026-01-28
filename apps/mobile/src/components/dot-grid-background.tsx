import React from "react";
import { StyleSheet, View } from "react-native";
import { Image } from "@/tw";
import BackgroundPattern from "../../assets/background_pattern.png";

interface DotGridBackgroundProps {
    children: React.ReactNode;
}

export function DotGridBackground({ children }: DotGridBackgroundProps) {
    return (
        <View style={styles.container}>
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
        backgroundColor: "#0d0e0d",
    },
    patternContainer: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 0,
    },
    patternImage: {
        ...StyleSheet.absoluteFillObject,
        opacity: 1,
    },
    content: {
        flex: 1,
        zIndex: 1,
    },
});
