import React, { useEffect } from "react";
import { View, Text, StyleSheet, SafeAreaView } from "react-native";
import { useTranslation } from "react-i18next";
import { useSelector, useDispatch } from "react-redux";
import { fetchProfile } from "@/store/reducers/profileReducer";

export default function AccountSettings() {
    const { t } = useTranslation();
    const dispatch = useDispatch();
    const profile = useSelector((state: { profile: { profile: any } }) => state.profile.profile);

    useEffect(() => {
        dispatch(fetchProfile());
    }, [dispatch]);

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
