import React from "react";
import { View, StyleSheet } from "react-native";

export const Navbar = () => {

    return (
        <View style={styles.container}>
            <View>
                Navbar
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        height: "100%",
        overflow: "scroll",
        display: "none",
    },
});
