import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { Card } from '@oxy.so/bloom/card';
import { Divider } from '@oxy.so/bloom/divider';
import { Field } from '@oxy.so/bloom/field';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Search } from '@oxy.so/bloom/search';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import { useQueryClient } from '@tanstack/react-query';
import { starterPacksService } from '@/services/starterPacksService';
import { router } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { logger } from '@oxy.so/core/logger';
import type { User } from '@oxy.so/core';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { SignInRequired } from '@/components/common/SignInRequired';

type MinimalUser = Pick<User, 'id' | 'username' | 'name' | 'avatar'>;

export default function CreateStarterPackScreen() {
  const { oxyServices, user } = useAuth();
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<MinimalUser[]>([]);
  const [members, setMembers] = useState<MinimalUser[]>([]);
  const [saving, setSaving] = useState(false);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  const doSearch = useCallback((q: string) => {
    setSearch(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q.trim()) { setResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      try {
        const { data } = await oxyServices.searchProfiles(q.trim(), { limit: 8 });
        setResults(data);
      } catch (e) {
        logger.warn('searchProfiles failed', { error: e });
      }
    }, 300);
  }, [oxyServices]);

  const addMember = (u: MinimalUser) => {
    if (members.find((m) => m.id === u.id)) return;
    if (members.length >= 150) return;
    setMembers((prev) => [...prev, u]);
  };
  const removeMember = (id: string) => setMembers((prev) => prev.filter((m) => m.id !== id));

  const onCreate = useCallback(async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await starterPacksService.create({
        name: name.trim(),
        description: description.trim() || undefined,
        memberOxyUserIds: members.map((m) => m.id),
      });
      // Refresh the viewer's cached pack list so the new pack appears in the
      // AddToStarterPackSheet (which now inherits the global staleTime).
      queryClient.invalidateQueries({
        queryKey: viewerQueryKeys.starterPacksMine(user?.id),
      });
      router.replace('/starter-packs');
    } catch (e) {
      logger.error('Create starter pack failed', e);
      toast.error(t('starterPacks.createFailed', { defaultValue: 'Could not create the starter pack' }));
    } finally {
      setSaving(false);
    }
  }, [name, description, members, queryClient, user?.id, t]);

  return (
    <View className="flex-1">
      <PageHeader
        title={t('starterPacks.create')}
        onBack={() => safeBack()}
        backLabel={t('common.back', { defaultValue: 'Back' })}
      />
      <SignInRequired
        label={t('starterPacks.signInRequired', { defaultValue: 'Sign in to use starter packs' })}
        description={t('starterPacks.signInRequiredDesc', {
          defaultValue: 'A starter pack is a set of accounts you recommend following together.',
        })}
      >
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <View className="gap-3 mb-2.5">
            <Field label="Name">
              <TextFieldInput
                label="Name"
                value={name}
                onChangeText={setName}
                placeholder="e.g. Tech people to follow"
              />
            </Field>

            <Field label="Description">
              <Textarea
                value={description}
                onChangeText={setDescription}
                placeholder={t('starterPacks.descriptionPlaceholder')}
                rows={3}
              />
            </Field>

            <Field label={`Add accounts (${members.length}/150)`} style={{ marginTop: 12 }}>
              <Search
                label={t('starterPacks.searchUsersPlaceholder')}
                value={search}
                onChangeText={doSearch}
                onClearText={() => doSearch('')}
              />
            </Field>
          </View>

          {results.length > 0 && (
            <Card appearance="outline" radius="radius-12">
              {results.map((u, index) => (
                <React.Fragment key={u.id}>
                  {index > 0 && <Divider />}
                  <TouchableOpacity className="flex-row items-center justify-between px-3 py-2.5" onPress={() => addMember(u)}>
                    <Text className="text-foreground font-primary">@{u.username} · {u.name.displayName}</Text>
                    <Text className="text-primary font-semibold font-primary">Add</Text>
                  </TouchableOpacity>
                </React.Fragment>
              ))}
            </Card>
          )}

          {members.length > 0 && (
            <View className="mt-2.5">
              <Text className="text-sm text-muted-foreground mb-1.5 font-primary">Members</Text>
              {members.map((m) => (
                <View key={m.id} className="flex-row items-center py-1.5">
                  <Text className="text-foreground">@{m.username}</Text>
                  <TouchableOpacity onPress={() => removeMember(m.id)}>
                    <Text className="text-destructive ml-2.5">Remove</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          <TouchableOpacity
            disabled={saving || !name.trim()}
            onPress={onCreate}
            className={cn(
              "mt-5 py-3 rounded-[10px] items-center bg-primary",
              !name.trim() && "opacity-60"
            )}
          >
            <Text className="text-primary-foreground font-bold font-primary">{saving ? 'Creating...' : 'Create Starter Pack'}</Text>
          </TouchableOpacity>
        </ScrollView>
      </SignInRequired>
    </View>
  );
}
