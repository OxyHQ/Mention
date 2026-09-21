import React from "react";
import { View, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { NoUpdatesIllustration } from "@/assets/illustrations/NoUpdates";
import { Button } from '@oxy.so/bloom/button';

interface Props {
    onEnable: () => void;
    onLater: () => void;
}

export const NotificationPermissionSheet: React.FC<Props> = ({ onEnable, onLater }) => {
    const { t } = useTranslation();

    return (
        <View className="bg-background px-5 pt-2 pb-4">
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
                <Button appearance="subtle" tone="neutral" size="large" onPress={onLater}>
                    {t("permission.notifications.later")}
                </Button>
                <Button appearance="solid" tone="accent" size="large" onPress={onEnable}>
                    {t("permission.notifications.enable")}
                </Button>
            </View>
        </View>
    );
};

export default NotificationPermissionSheet;
