import React, { useState, useEffect } from "react";
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    FlatList,
    ActivityIndicator,
    Keyboard,
} from "react-native";
import { useTheme } from "@/hooks/useTheme";
import { useOxy } from "@oxyhq/services";
import Avatar from "./Avatar";

export interface MentionUser {
    id: string;
    username: string;
    name: string;
    avatar?: string;
    verified?: boolean;
}

interface MentionPickerProps {
    query: string;
    onSelect: (user: MentionUser) => void;
    onClose: () => void;
    maxHeight?: number;
}

const MentionPicker: React.FC<MentionPickerProps> = ({
    query,
    onSelect,
    onClose,
    maxHeight = 300,
}) => {
    const theme = useTheme();
    const { oxyServices } = useOxy();
    const [users, setUsers] = useState<MentionUser[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        const searchUsers = async () => {
            if (!query || query.length < 1) {
                setUsers([]);
                return;
            }

            setLoading(true);
            try {
                // Search for users via Oxy services
                const searchResults = await oxyServices.searchProfiles(query, { limit: 10 });

                const mappedUsers: MentionUser[] = (searchResults || []).map((profile: any) => {
                    // Handle name object or string
                    let displayName = profile.username || profile.handle;
                    if (typeof profile.name === 'string') {
                        displayName = profile.name;
                    } else if (profile.name?.full) {
                        displayName = profile.name.full;
                    } else if (profile.name?.first) {
                        displayName = `${profile.name.first} ${profile.name.last || ''}`.trim();
                    } else if (profile.displayName) {
                        displayName = profile.displayName;
                    }

                    return {
                        id: profile.id || profile._id,
                        username: profile.username || profile.handle,
                        name: displayName,
                        avatar: profile.avatar || profile.profilePicture,
                        verified: profile.verified || false,
                    };
                });

                setUsers(mappedUsers);
            } catch (error) {
                console.error("Error searching users for mentions:", error);
                setUsers([]);
            } finally {
                setLoading(false);
            }
        };

        const debounceTimer = setTimeout(searchUsers, 300);
        return () => clearTimeout(debounceTimer);
    }, [query, oxyServices]);

    if (!query) {
        return null;
    }

    return (
        <View
            style={[
                styles.container,
                {
                    maxHeight,
                    backgroundColor: theme.colors.card,
                    borderColor: theme.colors.border,
                },
            ]}
        >
            {loading ? (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator color={theme.colors.primary} />
                </View>
            ) : users.length === 0 ? (
                <View style={styles.emptyContainer}>
                    <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                        No users found
                    </Text>
                </View>
            ) : (
                <FlatList
                    data={users}
                    keyExtractor={(item) => item.id}
                    keyboardShouldPersistTaps="handled"
                    renderItem={({ item }) => (
                        <TouchableOpacity
                            style={[
                                styles.userItem,
                                { borderBottomColor: theme.colors.border },
                            ]}
                            onPress={() => {
                                onSelect(item);
                                onClose();
                            }}
                        >
                            <Avatar
                                source={item.avatar ? { uri: oxyServices.getFileDownloadUrl(item.avatar, 'thumb') } : undefined}
                                size={40}
                            />
                            <View style={styles.userInfo}>
                                <View style={styles.userNameRow}>
                                    <Text
                                        style={[styles.userName, { color: theme.colors.text }]}
                                        numberOfLines={1}
                                    >
                                        {item.name}
                                    </Text>
                                    {item.verified && (
                                        <Text style={styles.verifiedBadge}>✓</Text>
                                    )}
                                </View>
                                <Text
                                    style={[styles.userHandle, { color: theme.colors.textSecondary }]}
                                    numberOfLines={1}
                                >
                                    @{item.username}
                                </Text>
                            </View>
                        </TouchableOpacity>
                    )}
                />
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        borderRadius: 12,
        borderWidth: 1,
        overflow: "hidden",
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 8,
        elevation: 4,
    },
    loadingContainer: {
        padding: 20,
        alignItems: "center",
        justifyContent: "center",
    },
    emptyContainer: {
        padding: 20,
        alignItems: "center",
        justifyContent: "center",
    },
    emptyText: {
        fontSize: 14,
    },
    userItem: {
        flexDirection: "row",
        alignItems: "center",
        padding: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    userInfo: {
        flex: 1,
        marginLeft: 12,
    },
    userNameRow: {
        flexDirection: "row",
        alignItems: "center",
    },
    userName: {
        fontSize: 15,
        fontWeight: "600",
        marginRight: 4,
    },
    verifiedBadge: {
        fontSize: 14,
        color: "#1DA1F2",
    },
    userHandle: {
        fontSize: 14,
        marginTop: 2,
    },
});

export default MentionPicker;
