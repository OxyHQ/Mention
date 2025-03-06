import React from 'react';
import { View, TouchableOpacity, ActivityIndicator } from 'react-native';
import { ThemedText } from '@/components/ThemedText';
import Avatar from '@/components/Avatar';
import { Session } from '../types';
import { sharedStyles } from './sharedStyles';
import { styles } from './styles';
import { useTranslation } from 'react-i18next';

interface SessionListProps {
    sessions: Session[];
    isLoadingSessions: boolean;
    handleSessionSwitch: (userId: string) => void;
    switchToSignin: () => void;
}

export const SessionList: React.FC<SessionListProps> = ({
    sessions,
    isLoadingSessions,
    handleSessionSwitch,
    switchToSignin,
}) => {
    const { t } = useTranslation();

    if (isLoadingSessions) {
        return (
            <View style={[sharedStyles.container, styles.centerContent]}>
                <ActivityIndicator size="large" />
            </View>
        );
    }

    if (sessions.length === 0) {
        return (
            <View style={[sharedStyles.container, styles.centerContent]}>
                <ThemedText style={sharedStyles.title}>{t('No active sessions')}</ThemedText>
                <TouchableOpacity onPress={switchToSignin} style={styles.switchModeButton}>
                    <ThemedText style={styles.switchModeText}>{t('Sign in with a different account')}</ThemedText>
                </TouchableOpacity>
            </View>
        );
    }

    return (
        <View style={sharedStyles.container}>
            <ThemedText style={sharedStyles.title}>{t('Choose Account')}</ThemedText>
            <ThemedText style={sharedStyles.subtitle}>{t('Select an account to continue')}</ThemedText>
            {sessions.map((session) => (
                <TouchableOpacity
                    key={session.id}
                    style={styles.sessionItem}
                    onPress={() => handleSessionSwitch(session.id)}
                >
                    <Avatar
                        size={40}
                        id={session.profile.avatar}
                    />
                    <View style={styles.sessionInfo}>
                        <ThemedText style={styles.sessionName}>
                            {session.profile.name?.first} {session.profile.name?.last}
                        </ThemedText>
                        <ThemedText style={styles.sessionUsername}>
                            @{session.profile.username}
                        </ThemedText>
                    </View>
                </TouchableOpacity>
            ))}
            <TouchableOpacity onPress={switchToSignin} style={styles.switchModeButton}>
                <ThemedText style={styles.switchModeText}>
                    {t('Use a different account')}
                </ThemedText>
            </TouchableOpacity>
        </View>
    );
};