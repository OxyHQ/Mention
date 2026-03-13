import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, ScrollView, Switch, Platform } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useAuth } from '@oxyhq/services';
import { listsService } from '@/services/listsService';
import { router } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

type MinimalUser = { id: string; username: string; name?: { full?: string } };

export default function CreateListScreen() {
  const { oxyServices } = useAuth();
  const theme = useTheme();
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<MinimalUser[]>([]);
  const [members, setMembers] = useState<MinimalUser[]>([]);
  const [saving, setSaving] = useState(false);

  const doSearch = useCallback(async (q: string) => {
    try {
      setSearch(q);
      if (!q.trim()) { setResults([]); return; }
      const res = await oxyServices.searchProfiles(q.trim(), { limit: 8 });
      setResults(res as any);
    } catch (e) {
      console.warn('searchProfiles failed', e);
    }
  }, [oxyServices]);

  const addMember = (u: MinimalUser) => {
    if (members.find((m) => m.id === u.id)) return;
    setMembers((prev) => [...prev, u]);
  };
  const removeMember = (id: string) => setMembers((prev) => prev.filter((m) => m.id !== id));

  const onCreate = useCallback(async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await listsService.create({
        title: title.trim(),
        description: description.trim() || undefined,
        isPublic,
        memberOxyUserIds: members.map((m) => m.id),
      });
      router.replace('/lists');
    } catch (e) {
      console.error('Create list failed', e);
    } finally {
      setSaving(false);
    }
  }, [title, description, isPublic, members]);

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('lists.create.title'),
          leftComponents: [
            <IconButton variant="icon"
              key="back"
              onPress={() => router.back()}
            >
              <BackArrowIcon size={20} color={theme.colors.text} />
            </IconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text className="text-sm text-muted-foreground mb-1.5 font-primary">{t('lists.create.titleLabel')}</Text>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder={t('lists.create.titlePlaceholder')}
          className="border border-border rounded-[10px] p-2.5 mb-2.5 text-foreground bg-background font-primary"
          style={styles.input}
        />

        <Text className="text-sm text-muted-foreground mb-1.5 font-primary">{t('lists.create.descriptionLabel')}</Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder={t('lists.create.descriptionPlaceholder')}
          className="border border-border rounded-[10px] p-2.5 mb-2.5 text-foreground bg-background font-primary h-20"
          style={styles.input}
          multiline
        />

        <View className="flex-row items-center justify-between mb-2.5">
          <Text className="text-sm text-muted-foreground font-primary">{t('lists.create.publicLabel')}</Text>
          <Switch value={isPublic} onValueChange={setIsPublic} />
        </View>

        <Text className="text-sm text-muted-foreground mb-1.5 mt-3 font-primary">{t('lists.create.addMembers')}</Text>
        <TextInput
          value={search}
          onChangeText={doSearch}
          placeholder={t('lists.create.searchUsersPlaceholder')}
          className="border border-border rounded-[10px] p-2.5 mb-2.5 text-foreground bg-background font-primary"
          style={styles.input}
        />

        {results.length > 0 && (
          <View className="border border-border rounded-[10px] overflow-hidden">
            {results.map((u) => (
              <TouchableOpacity key={u.id} className="flex-row items-center justify-between px-3 py-2.5 border-b border-border" onPress={() => addMember(u)}>
                <Text className="text-foreground font-primary">@{u.username} {(u.name?.full ? `• ${u.name.full}` : '')}</Text>
                <Text className="text-primary font-semibold font-primary">{t('lists.create.add')}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {members.length > 0 && (
          <View className="mt-2.5">
            <Text className="text-sm text-muted-foreground mb-1.5 font-primary">{t('lists.create.members')}</Text>
            {members.map((m) => (
              <View key={m.id} className="flex-row items-center py-1.5">
                <Text className="text-foreground">@{m.username}</Text>
                <TouchableOpacity onPress={() => removeMember(m.id)}>
                  <Text className="text-destructive ml-2.5">{t('lists.create.remove')}</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        <TouchableOpacity
          disabled={saving || !title.trim()}
          onPress={onCreate}
          className={cn(
            "mt-5 py-3 rounded-[10px] items-center bg-primary",
            !title.trim() && "opacity-60"
          )}
        >
          <Text className="text-primary-foreground font-bold font-primary">{saving ? t('lists.create.saving') : t('lists.create.createButton')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  input: {
    ...Platform.select({
      web: { outlineStyle: 'none' as any },
    }),
  },
});
