import React, { useContext, useEffect } from "react";
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity, ActivityIndicator } from "react-native";
import { useTranslation } from "react-i18next";
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { useRouter } from "expo-router";
import { Header } from "@/components/Header";
import { colors } from "@/styles/colors";
import { Ionicons } from "@expo/vector-icons";
import Avatar from "@/components/Avatar";
import { useDispatch, useSelector } from "react-redux";
import { RootState, AppDispatch } from "@/store/store";
import { fetchProfile } from "@/modules/oxyhqservices/reducers/profileReducer";

export default function AccountSettings() {
    const { t } = useTranslation();
    const sessionContext = useContext(SessionContext);
    const { logoutUser, getCurrentUserId } = sessionContext || {};
    const currentUserId = getCurrentUserId?.();
    const router = useRouter();
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
        }
        router.push('/login');
    };

    if (!currentUserId || loading) {
        return (
            <SafeAreaView style={styles.container}>
                <Header options={{
                    title: t("Account Settings"),
                    showBackButton: true,
                }} />
                <View style={styles.centered}>
                    {loading ? (
                        <ActivityIndicator color={colors.primaryColor} />
                    ) : (
                        <Text>{t("Please log in to view your account settings")}</Text>
                    )}
                </View>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.container}>
            <Header options={{
                title: t("Account Settings"),
                showBackButton: true,
            }} />
            
            <View style={styles.content}>
                <View style={styles.profileSection}>
                    <Avatar size={80} id={profile?.avatar} />
                    <View style={styles.profileInfo}>
                        <Text style={styles.name}>
                        {profile?.name?.first} {profile?.name?.last ? ` ${profile.name.last}` : ''}
                        </Text>
                        <Text style={styles.username}>{profile?.username ? `@${profile.username}` : ''}</Text>
                        {profile?.description && (
                            <Text style={styles.bio} numberOfLines={2}>{profile.description}</Text>
                        )}
                    </View>
                </View>

                <TouchableOpacity 
                    style={styles.editButton}
                    onPress={() => router.push('/settings/profile/edit')}
                >
                    <Ionicons name="pencil" size={20} color={colors.primaryColor} />
                    <Text style={styles.editButtonText}>{t("Edit Profile")}</Text>
                </TouchableOpacity>

                <View style={styles.statsSection}>
                    <View style={styles.stat}>
                        <Text style={styles.statNumber}>{profile?._count?.posts || 0}</Text>
                        <Text style={styles.statLabel}>{t("Posts")}</Text>
                    </View>
                    <View style={styles.stat}>
                        <Text style={styles.statNumber}>{profile?._count?.followers || 0}</Text>
                        <Text style={styles.statLabel}>{t("Followers")}</Text>
                    </View>
                    <View style={styles.stat}>
                        <Text style={styles.statNumber}>{profile?._count?.following || 0}</Text>
                        <Text style={styles.statLabel}>{t("Following")}</Text>
                    </View>
                </View>

                <View style={styles.section}>
                    <TouchableOpacity style={styles.menuItem}>
                        <Ionicons name="key-outline" size={24} color={colors.COLOR_BLACK} />
                        <Text style={styles.menuItemText}>{t("Change Password")}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.menuItem}>
                        <Ionicons name="mail-outline" size={24} color={colors.COLOR_BLACK} />
                        <Text style={styles.menuItemText}>{t("Update Email")}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.menuItem}>
                        <Ionicons name="shield-outline" size={24} color={colors.COLOR_BLACK} />
                        <Text style={styles.menuItemText}>{t("Two-Factor Authentication")}</Text>
                    </TouchableOpacity>
                </View>

                <TouchableOpacity 
                    style={styles.logoutButton} 
                    onPress={handleLogout}
                >
                    <Ionicons name="log-out-outline" size={24} />
                    <Text style={styles.logoutText}>{t("Logout")}</Text>
                </TouchableOpacity>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    content: {
        padding: 16,
    },
    profileSection: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 24,
    },
    profileInfo: {
        marginLeft: 16,
    },
    name: {
        fontSize: 20,
        fontWeight: 'bold',
        color: colors.COLOR_BLACK,
    },
    username: {
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    editButton: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#fff',
        padding: 12,
        borderRadius: 35,
        marginBottom: 24,
        borderWidth: 1,
        borderColor: colors.primaryColor,
    },
    editButtonText: {
        color: colors.primaryColor,
        fontSize: 16,
        fontWeight: '600',
        marginLeft: 8,
    },
    section: {
        backgroundColor: '#fff',
        borderRadius: 16,
        marginBottom: 24,
    },
    menuItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    menuItemText: {
        marginLeft: 12,
        fontSize: 16,
        color: colors.COLOR_BLACK,
    },
    logoutButton: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#fff',
        padding: 16,
        borderRadius: 16,
    },
    logoutText: {
        marginLeft: 12,
        fontSize: 16,
        color: colors.COLOR_BLACK,
        fontWeight: '600',
    },
    centered: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    bio: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
        marginTop: 4,
    },
    statsSection: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        backgroundColor: '#fff',
        padding: 16,
        borderRadius: 16,
        marginBottom: 24,
    },
    stat: {
        alignItems: 'center',
    },
    statNumber: {
        fontSize: 18,
        fontWeight: 'bold',
        color: colors.COLOR_BLACK,
    },
    statLabel: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
        marginTop: 4,
    },
});
