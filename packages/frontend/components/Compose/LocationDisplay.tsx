import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { LocationIcon } from "@/assets/icons/location-icon";
import { CloseIcon } from "@/assets/icons/close-icon";

interface LocationDisplayProps {
    location: {
        latitude: number;
        longitude: number;
        address?: string;
    } | null;
    onRemove: () => void;
    isGettingLocation?: boolean;
    style?: any;
}

export const LocationDisplay: React.FC<LocationDisplayProps> = ({
    location,
    onRemove,
    isGettingLocation = false,
    style,
}) => {
    const theme = useTheme();
    const { t } = useTranslation();

    if (!location && !isGettingLocation) return null;

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.backgroundSecondary, borderColor: theme.colors.border }, style]}>
            <View style={styles.header}>
                <LocationIcon size={16} className="text-primary" />
                {isGettingLocation ? (
                    <>
                        <Loading size="small" style={{ flex: undefined }} />
                        <Text style={[styles.text, { color: theme.colors.textSecondary }]}>
                            {t('compose.location.getting', { defaultValue: 'Getting location...' })}
                        </Text>
                    </>
                ) : (
                    <>
                        <Text style={[styles.text, { color: theme.colors.text }]}>{location?.address}</Text>
                        <TouchableOpacity onPress={onRemove}>
                            <CloseIcon size={16} className="text-muted-foreground" />
                        </TouchableOpacity>
                    </>
                )}
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        borderRadius: 8,
        padding: 12,
        marginTop: 8,
        borderWidth: 1,
    },
    header: {
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
    },
    text: {
        flex: 1,
        fontSize: 14,
        fontWeight: "500",
    },
});
