import React from 'react';
import { View, Text, StyleSheet, Image } from 'react-native';
import { colors } from '@/styles/colors';
import { MentionLogo } from '@/assets/mention-logo'; // Adjust the path to your logo image

const WebSplashScreen = () => {
    return (
        <View style={styles.container}>
            <MentionLogo size={80} color={colors.primaryColor} />
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: colors.COLOR_BACKGROUND,
    },
    logo: {
        width: 100,
        height: 100,
        marginBottom: 20,
    },
    text: {
        fontSize: 24,
        color: colors.primaryColor,
    },
});

export default WebSplashScreen;
