import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Switch } from 'react-native';
import { Card } from '@oxy.so/bloom/card';
import { Divider } from '@oxy.so/bloom/divider';
import { Field } from '@oxy.so/bloom/field';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Search } from '@oxy.so/bloom/search';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import { listsService } from '@/services/listsService';
import { router } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { logger } from '@oxy.so/core/logger';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { SignInRequired } from '@/components/common/SignInRequired';
import type { User } from '@oxy.so/core';

type MinimalUser = Pick<User, 'id' | 'username' | 'name' | 'avatar'>;

export default function CreateListScreen() {
  const { oxyServices } = useAuth();
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(true);
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
    } catch (error) {
      logger.error('Create list failed', error);
      toast.error(t('lists.create.failed', { defaultValue: 'Could not create the list' }));
    } finally {
      setSaving(false);
    }
  }, [title, description, isPublic, members, t]);

  return (
    <View className="flex-1">
      <PageHeader
        title={t('lists.create.title')}
        onBack={() => safeBack()}
        backLabel={t('common.back', { defaultValue: 'Back' })}
      />
      <SignInRequired
        label={t('lists.signInRequired', { defaultValue: 'Sign in to use lists' })}
        description={t('lists.signInRequiredDesc', {
          defaultValue: 'Lists group the accounts you want to read together. The ones you create or follow appear here.',
        })}
      >
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <View className="gap-3 mb-2.5">
            <Field label={t('lists.create.titleLabel')}>
              <TextFieldInput
                label={t('lists.create.titleLabel')}
                value={title}
                onChangeText={setTitle}
                placeholder={t('lists.create.titlePlaceholder')}
              />
            </Field>

            <Field label={t('lists.create.descriptionLabel')}>
              <Textarea
                value={description}
                onChangeText={setDescription}
                placeholder={t('lists.create.descriptionPlaceholder')}
                rows={3}
              />
            </Field>

            <View className="flex-row items-center justify-between">
              <Text className="text-sm text-muted-foreground font-primary">{t('lists.create.publicLabel')}</Text>
              <Switch value={isPublic} onValueChange={setIsPublic} />
            </View>

            <Field label={t('lists.create.addMembers')} style={{ marginTop: 12 }}>
              <Search
                label={t('lists.create.searchUsersPlaceholder')}
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
                    <Text className="text-foreground font-primary">@{u.username} • {u.name.displayName}</Text>
                    <Text className="text-primary font-semibold font-primary">{t('lists.create.add')}</Text>
                  </TouchableOpacity>
                </React.Fragment>
              ))}
            </Card>
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
      </SignInRequired>
    </View>
  );
}
