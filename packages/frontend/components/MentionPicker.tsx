import React, { useState, useEffect } from "react";
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    FlatList,
} from "react-native";
import { Loading } from '@oxyhq/bloom/loading';
import { useAuth } from "@oxyhq/services/ui/client";
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { logger } from '@oxyhq/core/logger';
import UserName from '@/components/UserName';

export interface MentionUser {
    id: string;
    username: string;
    displayName?: string;
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
    const { oxyServices } = useAuth();
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
                const { data: searchResults } = await oxyServices.searchProfiles(query, { limit: 10 });

                const mappedUsers: MentionUser[] = (searchResults || []).flatMap((profile: {
                    id?: string;
                    _id?: string;
                    username?: string;
                    handle?: string;
                    name?: { displayName?: string };
                    avatar?: string | null;
                    profilePicture?: string;
                    verified?: boolean;
                }) => {
                    const id = profile.id || profile._id;
                    const username = profile.username || profile.handle || '';
                    if (!id || !username) {
                        return [];
                    }
                    return [{
                        id,
                        username,
                        displayName: profile.name?.displayName,
                        avatar: profile.avatar || profile.profilePicture || undefined,
                        verified: profile.verified || false,
                    }];
                });

                setUsers(mappedUsers);
            } catch (error) {
                logger.error("Error searching users for mentions", error);
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
            className="bg-card border-border"
            style={[
                styles.container,
                {
                    maxHeight,
                },
            ]}
        >
            {loading ? (
                <View style={styles.loadingContainer}>
                    <Loading className="text-primary" size="small" style={{ flex: undefined }} />
                </View>
            ) : users.length === 0 ? (
                <View style={styles.emptyContainer}>
                    <Text className="text-muted-foreground" style={styles.emptyText}>
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
                            className="border-b-border"
                            style={styles.userItem}
                            onPress={() => {
                                onSelect(item);
                                onClose();
                            }}
                        >
                            <Avatar
                                source={item.avatar}
                                size={40}
                                variant={MEDIA_VARIANT_AVATAR}
                            />
                            {/* The shared identity line, like every other user
                                surface. This row used to hand-roll it — and with
                                it a second copy of the "display name else handle,
                                once" rule and a literal `✓` in its own blue. */}
                            <View style={styles.userInfo}>
                                <UserName
                                    name={item.displayName}
                                    handle={item.username}
                                    verified={item.verified}
                                    style={{ name: styles.userName, handle: styles.userHandle }}
                                />
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
        boxShadow: '0px 2px 8px 0px rgba(0, 0, 0, 0.1)',
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
    userName: {
        fontSize: 15,
        fontWeight: "600",
    },
    userHandle: {
        fontSize: 14,
        marginTop: 2,
    },
});

export default MentionPicker;
