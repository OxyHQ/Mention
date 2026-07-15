import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { useAuth } from '@oxyhq/services';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { logger } from '@/lib/logger';
import { displayNameOrHandle } from '@/utils/displayName';
import { MAX_POST_COLLABORATORS } from '@mention/shared-types';

export interface CollaboratorUser {
  id: string;
  username: string;
  displayName?: string;
  avatar?: string;
}

interface CollaboratorPickerProps {
  selected: CollaboratorUser[];
  onChange: (users: CollaboratorUser[]) => void;
  disabled?: boolean;
}

const CollaboratorPicker: React.FC<CollaboratorPickerProps> = ({ selected, onChange, disabled }) => {
  const { t } = useTranslation();
  const { oxyServices, user } = useAuth();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CollaboratorUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const search = async () => {
      if (!query || query.length < 1) {
        setResults([]);
        return;
      }
      setLoading(true);
      try {
        const { data: searchResults } = await oxyServices.searchProfiles(query, { limit: 10 });
        const mapped: CollaboratorUser[] = (searchResults || []).flatMap((profile: {
          id?: string;
          _id?: string;
          username?: string;
          handle?: string;
          name?: { displayName?: string };
          avatar?: string | null;
        }) => {
          const username = profile.username || profile.handle || '';
          const id = profile.id || profile._id || '';
          if (!username || !id) return [];
          return [{
            id,
            username,
            displayName: profile.name?.displayName,
            avatar: profile.avatar || undefined,
          }];
        });
        setResults(mapped.filter((u) => u.id !== user?.id));
      } catch {
        logger.error('Collaborator search failed');
        setResults([]);
      } finally {
        setLoading(false);
      }
    };
    const timer = setTimeout(search, 300);
    return () => clearTimeout(timer);
  }, [query, oxyServices, user?.id]);

  const selectedIds = new Set(selected.map((s) => s.id));

  const addUser = (collaborator: CollaboratorUser) => {
    if (selectedIds.has(collaborator.id)) return;
    if (selected.length >= MAX_POST_COLLABORATORS) return;
    onChange([...selected, collaborator]);
    setQuery('');
    setResults([]);
  };

  const removeUser = (id: string) => {
    onChange(selected.filter((s) => s.id !== id));
  };

  if (disabled) return null;

  return (
    <View className="px-4 pb-2">
      {selected.length > 0 && (
        <View className="flex-row flex-wrap gap-2 mb-2">
          {selected.map((collab) => (
            <View key={collab.id} className="flex-row items-center bg-surface border border-border rounded-full pl-1 pr-2 py-1 gap-1">
              <Avatar source={collab.avatar} size={24} variant={MEDIA_VARIANT_AVATAR} />
              <Text className="text-foreground text-sm" numberOfLines={1}>
                {displayNameOrHandle(collab.displayName, `@${collab.username}`)}
              </Text>
              <TouchableOpacity onPress={() => removeUser(collab.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close-circle" size={18} className="text-muted-foreground" />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {selected.length < MAX_POST_COLLABORATORS && (
        <>
          {!expanded ? (
            <TouchableOpacity
              className="flex-row items-center gap-2 py-2"
              onPress={() => setExpanded(true)}
            >
              <Ionicons name="people-outline" size={20} className="text-primary" />
              <Text className="text-primary text-[15px]">
                {t('collab.inviteCollaborators', { defaultValue: 'Invite collaborators' })}
              </Text>
            </TouchableOpacity>
          ) : (
            <View className="border border-border rounded-xl bg-card overflow-hidden">
              <View className="flex-row items-center px-3 py-2 gap-2">
                <Ionicons name="search" size={18} className="text-muted-foreground" />
                <TextInput
                  className="flex-1 text-foreground text-[15px]"
                  placeholder={t('collab.searchPlaceholder', { defaultValue: 'Search people to collaborate with' })}
                  placeholderTextColor="#888"
                  value={query}
                  onChangeText={setQuery}
                  autoFocus
                />
                <TouchableOpacity onPress={() => { setExpanded(false); setQuery(''); setResults([]); }}>
                  <Ionicons name="close" size={20} className="text-muted-foreground" />
                </TouchableOpacity>
              </View>
              {loading ? (
                <View style={styles.loadingRow}>
                  <Loading className="text-primary" size="small" style={{ flex: undefined }} />
                </View>
              ) : (
                <FlatList
                  data={results.filter((r) => !selectedIds.has(r.id))}
                  keyExtractor={(item) => item.id}
                  keyboardShouldPersistTaps="handled"
                  style={{ maxHeight: 200 }}
                  ListEmptyComponent={
                    query.length > 0 ? (
                      <Text className="text-muted-foreground text-sm p-3 text-center">
                        {t('collab.noResults', { defaultValue: 'No users found' })}
                      </Text>
                    ) : null
                  }
                  renderItem={({ item }) => (
                    <TouchableOpacity className="flex-row items-center px-3 py-2 gap-3" onPress={() => addUser(item)}>
                      <Avatar source={item.avatar} size={32} variant={MEDIA_VARIANT_AVATAR} />
                      <View className="flex-1">
                        <Text className="text-foreground text-[15px] font-medium">
                          {displayNameOrHandle(item.displayName, item.username)}
                        </Text>
                        <Text className="text-muted-foreground text-sm">@{item.username}</Text>
                      </View>
                    </TouchableOpacity>
                  )}
                />
              )}
            </View>
          )}
        </>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  loadingRow: { padding: 12, alignItems: 'center' },
});

export default CollaboratorPicker;
