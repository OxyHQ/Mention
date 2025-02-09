import React from 'react';
import { View } from 'react-native';
import { MentionLogo } from '@/assets/mention-logo';
import { colors } from '@/styles/colors';

const WebSplashScreen = () => {
    return (
        <View className="flex-1 items-center justify-center bg-primary-light dark:bg-primary-dark">
            <MentionLogo size={80} color={colors.primaryColor} />
        </View>
    );
};

export default WebSplashScreen;
