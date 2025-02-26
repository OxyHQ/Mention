import React, { useContext, useEffect } from 'react';
import { View, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SessionContext } from '../SessionProvider';
import { colors } from '@/styles/colors';
import { Ionicons } from '@expo/vector-icons';
import Avatar from '@/components/Avatar';
import { useDispatch, useSelector } from 'react-redux';
import { RootState, AppDispatch } from '@/store/store';
import { fetchProfile } from '../../reducers/profileReducer';
import { BaseBottomSheet } from '../BaseBottomSheet';
import { ThemedText } from '@/components/ThemedText';

export function ProfileSettingsBottomSheet({ onClose }: { onClose: () => void }) {
    const { t } = useTranslation();
    const sessionContext = useContext(SessionContext);
    const { logoutUser, getCurrentUserId } = sessionContext || {};
    const currentUserId = getCurrentUserId?.();
    const dispatch = useDispatch<AppDispatch>();
    const { profile, loading } = useSelector((state: RootState) => state.profile);

    useEffect(() => {
        if (currentUserId) {
            dispatch(fetchProfile({ username: currentUserId }));
        }
    }, [currentUserId, dispatch]);

    const handleLogout = () => {
        if (logoutUser) {
            logoutUser();
            onClose();
        }
    };

    const content = loading ? (
        <View style={styles.centered}>
            <ActivityIndicator color={colors.primaryColor} />
        </View>
    ) : (
        <View style={styles.content}>
            <View style={styles.profileSection}>
                {currentUserId && <Avatar size={80} id={currentUserId} />}
                <View style={styles.profileInfo}>
                    <ThemedText style={styles.name}>{profile?.name?.first || profile?.username}</ThemedText>
                    <ThemedText style={styles.username}>@{profile?.username}</ThemedText>
                </View>
            </View>
            <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
                <Ionicons name="log-out-outline" size={24} color={colors.primaryColor} />
                <ThemedText style={styles.logoutText}>{t("Logout")}</ThemedText>
            </TouchableOpacity>
        </View>
    );

    return (
        <BaseBottomSheet
            title={t("Account Settings")}
            showLogo={false}
            onClose={onClose}
        >
            {content}
        </BaseBottomSheet>
    );
}

const styles = StyleSheet.create({
    centered: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    content: {
        padding: 20,
    },
    profileSection: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 30,
    },
    profileInfo: {
        marginLeft: 15,
    },
    name: {
        fontSize: 20,
        fontWeight: 'bold',
    },
    username: {
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    logoutButton: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 15,
        borderTopWidth: 1,
        borderTopColor: colors.COLOR_BLACK_LIGHT_6,
    },
    logoutText: {
        marginLeft: 10,
        fontSize: 16,
        color: colors.primaryColor,
    },
});