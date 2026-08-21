import React from "react";
import { View, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { ThemedView } from "@/components/ThemedView";
import { NoUpdatesIllustration } from "@/assets/illustrations/NoUpdates";
import { Button } from '@oxyhq/bloom/button';

interface Props {
    onEnable: () => void;
    onLater: () => void;
}

export const NotificationPermissionSheet: React.FC<Props> = ({ onEnable, onLater }) => {
    const { t } = useTranslation();

    return (
        <ThemedView className="px-5 pt-2 pb-4">
            <View className="items-center justify-center mt-1.5 mb-2.5">
                <NoUpdatesIllustration width={140} height={140} />
            </View>
            <Text className="mb-1.5 text-center text-lg font-semibold text-foreground">
                {t("permission.notifications.title")}
            </Text>
            <Text className="mx-2 text-center text-sm text-muted-foreground">
                {t("permission.notifications.subtitle")}
            </Text>
            <View className="mt-3.5 gap-2.5">
                <Button variant="secondary" size="large" onPress={onLater}>
                    {t("permission.notifications.later")}
                </Button>
                <Button variant="primary" size="large" onPress={onEnable}>
                    {t("permission.notifications.enable")}
                </Button>
            </View>
        </ThemedView>
    );
};

export default NotificationPermissionSheet;
