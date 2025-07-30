import { LogoIcon } from '@/assets/logo';
import { colors } from '@/styles/colors';
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

const WebSplashScreen = () => {
    return (
        <LinearGradient
            colors={[colors.primaryLight, colors.primaryLight, colors.primaryColor]}
            style={styles.container}
        >
            <View style={styles.content}>
                <LogoIcon size={100} color={colors.primaryColor} />
            </View>
        </LinearGradient>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    content: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
});

export default WebSplashScreen;
