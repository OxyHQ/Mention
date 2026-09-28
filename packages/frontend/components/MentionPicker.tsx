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
import { Avatar } from '@oxy.so/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { logger } from '@oxy.so/core/logger';
import UserName from '@/components/UserName';
import { EmptyState } from '@/components/common/EmptyState';
import type { MentionSearchCache, MentionUser } from '@/utils/mentionSearch';

export type { MentionUser };

interface MentionPickerProps {
    query: string;
    /** The composer session's search cache, shared with typed-handle resolution. */
    searchCache: MentionSearchCache;
    onSelect: (user: MentionUser) => void;
    onClose: () => void;
    maxHeight?: number;
}

const MentionPicker: React.FC<MentionPickerProps> = ({
    query,
    searchCache,
    onSelect,
    onClose,
    maxHeight = 300,
}) => {
    const { t } = useTranslation();
    const [searched, setSearched] = useState<MentionUser[]>([]);
    const [searching, setSearching] = useState(false);

    // Results the composer session already holds show at once. The same cache
    // answers a typed handle when it is completed, so reading from it here is
    // what keeps that from being a second request.
    const cached = query ? searchCache.peek(query) : undefined;

    useEffect(() => {
        if (!query || searchCache.peek(query)) return;

        let cancelled = false;
        const searchUsers = async () => {
            setSearching(true);
            try {
                const results = await searchCache.search(query);
                if (!cancelled) setSearched(results);
            } catch (error) {
                logger.error("Error searching users for mentions", error);
                if (!cancelled) setSearched([]);
            } finally {
                if (!cancelled) setSearching(false);
            }
        };

        const debounceTimer = setTimeout(searchUsers, 300);
        return () => {
            cancelled = true;
            clearTimeout(debounceTimer);
        };
    }, [query, searchCache]);

    const users = cached ?? searched;
    const loading = !cached && searching;

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
