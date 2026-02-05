import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { Loading } from '@/components/ui/Loading';
import { LocationIcon } from "@/assets/icons/location-icon";
import { CloseIcon } from "@/assets/icons/close-icon";
import { colors } from "@/styles/colors";

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
    if (!location && !isGettingLocation) return null;

    return (
        <View style={[styles.container, style]}>
            <View style={styles.header}>
                <LocationIcon size={16} color={colors.primaryColor} />
                {isGettingLocation ? (
                    <>
                        <Loading size="small" style={{ flex: undefined }} />
                        <Text style={styles.text}>Getting location...</Text>
                    </>
                ) : (
                    <>
                        <Text style={styles.text}>{location?.address}</Text>
                        <TouchableOpacity onPress={onRemove}>
                            <CloseIcon size={16} color={colors.COLOR_BLACK_LIGHT_4} />
                        </TouchableOpacity>
                    </>
                )}
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
        borderRadius: 8,
        padding: 12,
        marginTop: 8,
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
    },
    header: {
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
    },
    text: {
        flex: 1,
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_2,
        fontWeight: "500",
    },
});
