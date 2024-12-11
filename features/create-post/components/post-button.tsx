import React from "react";
import { View, StyleSheet, Button } from "react-native";
import { useOxySession } from "@oxyhq/services";

export const PostButton = () => {
    const { session } = useOxySession();

    return (
        <View style={styles.container}>
            <View style={styles.button}>
                <Button
                    title="Create Post"
                    onPress={() => { }}
                />
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        display: "flex",
        justifyContent: "center",
    },
    button: {
        width: "100%",
    },
    // Add media query styles here
    small: {
        // Media queries need to be handled with Dimensions API or similar
        padding: 4,
    },
    medium: {
        padding: 8,
    },
    xxLarge: {
        // Nested styles are not supported in React Native
    },
});
