import React, { useContext, useEffect } from "react";
import { SafeAreaView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { Header } from "@/components/Header";
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { ProfileSettingsBottomSheet } from '@/modules/oxyhqservices/components/ProfileSettingsBottomSheet';

export default function AccountSettings() {
    const { t } = useTranslation();
    const { openBottomSheet, setBottomSheetContent } = useContext(BottomSheetContext);

    useEffect(() => {
        const showSettings = () => {
            setBottomSheetContent(
                <ProfileSettingsBottomSheet onClose={() => openBottomSheet(false)} />
            );
            openBottomSheet(true);
        };
        
        // Show settings bottom sheet automatically when the page loads
        showSettings();
    }, []);

    return (
        <SafeAreaView style={styles.container}>
            <Header options={{
                title: t("Account Settings"),
                showBackButton: true,
            }} />
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
});
