import React, { useState, useEffect } from "react";
import {
    View,
    TouchableOpacity,
    StyleSheet,
    FlatList,
} from "react-native";
import { useTranslation } from "react-i18next";
import { Card } from '@oxy.so/bloom/card';
import { Loading } from '@oxy.so/bloom/loading';
import { useAuth } from "@oxy.so/services/ui/client";
import { Avatar } from '@oxy.so/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { logger } from '@oxy.so/core/logger';
import UserName from '@/components/UserName';
import { EmptyState } from '@/components/common/EmptyState';

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
    const { t } = useTranslation();
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
        <Card border="thin" elevation="m" radius="radius-12" style={{ maxHeight }}>
            {loading ? (
                <View style={styles.loadingContainer}>
                    <Loading className="text-primary" size="small" style={{ flex: undefined }} />
                </View>
            ) : users.length === 0 ? (
                <EmptyState title={t('collab.noResults', { defaultValue: 'No users found' })} />
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
        </Card>
    );
};

const styles = StyleSheet.create({
    loadingContainer: {
        padding: 20,
        alignItems: "center",
        justifyContent: "center",
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
