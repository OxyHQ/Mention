import React from "react";
import { View, StyleSheet } from "react-native";
import { useOxySession } from "@oxyhq/services";

import { SessionOwnerButton } from "@oxyhq/services";
import { PostButton } from "@/features/create-post";
import { Navbar } from "@/features/navbar";

import { Logo } from "./logo";

export const Sidebar = () => {
    const { session } = useOxySession();

    return (
        <View style={styles.container}>
            <View style={styles.logo}>
                <Logo />
            </View>
            <View style={styles.navbar}>
                <Navbar />
            </View>
            {session && (
                <View style={styles.postButton}>
                    <PostButton />
                </View>
            )}
            {session && (
                <View style={styles.user}>
                    <SessionOwnerButton />
                </View>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        position: "absolute",
        top: 0,
        height: "100%",
        overflow: "scroll",
        display: "none",
    },
    logo: {
        display: "flex",
        justifyContent: "center",
    },
    navbar: {
        display: "flex",
        justifyContent: "center",
    },
    postButton: {
        display: "flex",
        justifyContent: "center",
    },
    user: {
        display: "flex",
        justifyContent: "center",
        marginTop: "auto",
    },
    // Add media query equivalent logic if needed using `react-native-responsive`
});
