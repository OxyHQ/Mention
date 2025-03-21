import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TextInput } from "react-native";
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from "react-native-reanimated";
import { colors } from "@/styles/colors";
import { useTranslation } from "react-i18next";

const KaanaClientPage = () => {
    const { t } = useTranslation();
    const placeholders = [
        t("kaana.placeholder.fight_club"),
        t("kaana.placeholder.adam_mosseri"),
        t("kaana.placeholder.enric_duran"),
        t("kaana.placeholder.javascript"),
        t("kaana.placeholder.pc_build"),
        t("kaana.placeholder.nate"),
    ];

    const [currentPlaceholder, setCurrentPlaceholder] = useState(0);
    const [inputText, setInputText] = useState("");
    const [inputHeight, setInputHeight] = useState(40);

    // Use Reanimated shared values for better performance
    const opacity = useSharedValue(1);
    const translateY = useSharedValue(0);

    useEffect(() => {
        const interval = setInterval(() => {
            opacity.value = withTiming(0, {
                duration: 1000,
                easing: Easing.out(Easing.ease),
            });
            translateY.value = withTiming(-20, {
                duration: 1000,
                easing: Easing.out(Easing.ease),
            }, () => {
                setCurrentPlaceholder((prev) => (prev + 1) % placeholders.length);
                translateY.value = 20;
                opacity.value = withTiming(1, {
                    duration: 1000,
                    easing: Easing.out(Easing.ease),
                });
                translateY.value = withTiming(0, {
                    duration: 1000,
                    easing: Easing.out(Easing.ease),
                });
            });
        }, 5000);

        return () => clearInterval(interval);
    }, []);

    const animatedStyle = useAnimatedStyle(() => ({
        opacity: opacity.value,
        transform: [{ translateY: translateY.value }],
    }));

    const handleTextChange = (text: string) => {
        setInputText(text);
    };

    const handleContentSizeChange = (event: { nativeEvent: { contentSize: { height: number; }; }; }) => {
        const contentHeight = Math.max(40, event.nativeEvent.contentSize.height);
        if (inputHeight !== contentHeight) {
            setInputHeight(contentHeight);
        }
    };

    return (
        <View style={styles.container}>
            <Text style={styles.title}>Ask Kaana Anything</Text>
            <View style={styles.inputContainer}>
                <TextInput
                    style={[styles.input, { height: inputHeight }]}
                    placeholder=""
                    placeholderTextColor="#aaa"
                    multiline
                    value={inputText}
                    onChangeText={handleTextChange}
                    onContentSizeChange={handleContentSizeChange}
                />
                {!inputText && (
                    <Animated.Text style={[styles.animatedPlaceholder, animatedStyle]}>
                        {placeholders[currentPlaceholder]}
                    </Animated.Text>
                )}
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.primaryColor,
        padding: 16,
        borderRadius: 35,
    },
    title: {
        marginBottom: 10,
        textAlign: "center",
        fontSize: 24,
        fontWeight: "bold",
        color: "#fff",
    },
    inputContainer: {
        width: "100%",
        position: "relative",
    },
    input: {
        fontSize: 18,
        color: colors.COLOR_BLACK,
        textAlign: "center",
        backgroundColor: colors.primaryLight,
        padding: 10,
        borderRadius: 35,
    },
    animatedPlaceholder: {
        position: "absolute",
        top: 10,
        left: 10,
        right: 10,
        fontSize: 18,
        color: "#aaa",
        textAlign: "center",
    },
});

export default KaanaClientPage;
