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
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { AuthBottomSheet } from '@/modules/oxyhqservices/components/AuthBottomSheet';

export default function AccountSettings() {
    const { t } = useTranslation();
    const sessionContext = useContext(SessionContext);
    const { logoutUser, getCurrentUserId } = sessionContext || {};
    const currentUserId = getCurrentUserId?.();
    const router = useRouter();
    const dispatch = useDispatch<AppDispatch>();
    const { profile, loading } = useSelector((state: RootState) => state.profile);
    const { openBottomSheet, setBottomSheetContent } = useContext(BottomSheetContext);

    useEffect(() => {
        if (currentUserId) {
            dispatch(fetchProfile({ username: currentUserId }));
        }
    }, [currentUserId, dispatch]);

    const handleLogout = () => {
        if (logoutUser) {
            logoutUser();
        }
    };

    const handleAuthClick = () => {
        setBottomSheetContent(<AuthBottomSheet />);
        openBottomSheet(true);
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
                        <>
                            <Text style={styles.message}>{t("Please log in to view your account settings")}</Text>
                            <TouchableOpacity style={styles.loginButton} onPress={handleAuthClick}>
                                <Text style={styles.loginButtonText}>{t("Sign In")}</Text>
                            </TouchableOpacity>
                        </>
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
                    <Avatar size={80} id={currentUserId} />
                    <View style={styles.profileInfo}>
                        <Text style={styles.name}>{profile?.name?.first || profile?.username}</Text>
                        <Text style={styles.username}>@{profile?.username}</Text>
                    </View>
                </View>
                <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
                    <Ionicons name="log-out-outline" size={24} color={colors.primaryColor} />
                    <Text style={styles.logoutText}>{t("Logout")}</Text>
                </TouchableOpacity>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.primaryLight,
    },
    centered: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    message: {
        fontSize: 16,
        color: colors.COLOR_BLACK,
        textAlign: 'center',
        marginBottom: 20,
    },
    loginButton: {
        backgroundColor: colors.primaryColor,
        paddingHorizontal: 30,
        paddingVertical: 12,
        borderRadius: 25,
    },
    loginButtonText: {
        color: colors.primaryLight,
        fontSize: 16,
        fontWeight: 'bold',
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
        color: colors.COLOR_BLACK,
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
