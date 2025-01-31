import React, { useEffect, useContext } from "react";
import { View, Text, StyleSheet, SafeAreaView, Button } from "react-native";
import { useTranslation } from "react-i18next";
import { useSelector, useDispatch } from "react-redux";
import { fetchProfile } from "@/store/reducers/profileReducer";
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { useRouter } from "expo-router";

export default function AccountSettings() {
    const { t } = useTranslation();
    const dispatch = useDispatch();
    const profile = useSelector((state: { profile: { profile: any } }) => state.profile.profile);
    const { logoutUser } = useContext(SessionContext);
    const router = useRouter();

    useEffect(() => {
        dispatch(fetchProfile());
    }, [dispatch]);

    const handleLogout = () => {
        logoutUser();
        router.push('/login');
    };

    return (
        <SafeAreaView style={styles.container}>
            <Text style={styles.title}>{t("Account Settings")}</Text>
            {profile && (
                <View>
                    <Text>{t("Name")}: {profile.name}</Text>
                    <Text>{t("Username")}: {profile.username}</Text>
                    <Text>{t("Avatar")}: {profile.avatar}</Text>
                </View>
            )}
            <Button title={t("Logout")} onPress={handleLogout} />
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 16,
        backgroundColor: '#fff',
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        marginBottom: 16,
    },
});
