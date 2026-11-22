import { SupervisedFeatureGate } from '@/components/SupervisedFeatureGate';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TouchableOpacity, type ViewStyle } from 'react-native';
import { Field } from '@oxy.so/bloom/field';
import { Screen } from '@oxy.so/bloom/screen';
import { Search } from '@oxy.so/bloom/search';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { useColorTokens } from '@oxy.so/bloom/theme';
import { useAuth } from '@oxy.so/services/ui/client';
import { listsService } from '@/services/listsService';
import { useRouter } from '@/lib/navigation/router';
import { logger } from '@oxy.so/core/logger';
import { useTranslation } from 'react-i18next';
import { SignInRequired } from '@/components/common/SignInRequired';
import type { User } from '@oxy.so/core';

import {
  Card as LCard,
  Divider as LDivider,
  Embed,
  Field as LField,
  HStack,
  Header,
  RawText,
  ScrollView,
  Toggle,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

// Kept as React Native's TouchableOpacity (the language has no node for its fading
// press); its style draws what its classes drew.
const touchables = {
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  create: { marginTop: 20, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
} satisfies Record<string, ViewStyle>;

type MinimalUser = Pick<User, 'id' | 'username' | 'name' | 'avatar'>;

function CreateListScreen() {
  const colors = useColorTokens();
  const router = useRouter();
  const { oxyServices } = useAuth();
  const { t } = useTranslation();
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

  const doSearch = useCallback(
    (q: string) => {
      setSearch(q);
      if (searchTimer.current) clearTimeout(searchTimer.current);
      if (!q.trim()) {
        setResults([]);
        return;
      }
      searchTimer.current = setTimeout(async () => {
        try {
          const { data } = await oxyServices.users.search(q.trim(), { limit: 8 });
          setResults(data);
        } catch (e) {
          logger.warn('searchProfiles failed', { error: e });
        }
      }, 300);
    },
    [oxyServices],
  );

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
  }, [title, description, isPublic, members, t, router]);

  return (
    <Screen
      header={toElement(
        Header(t('lists.create.title'))
          .backLabel(t('common.back', { defaultValue: 'Back' }))
          .inPage(),
      )}
    >
      <SignInRequired
        label={t('lists.signInRequired', { defaultValue: 'Sign in to use lists' })}
        description={t('lists.signInRequiredDesc', {
          defaultValue:
            'Lists group the accounts you want to read together. The ones you create or follow appear here.',
        })}
      >
        {toElement(
          ScrollView(
            VStack(
              LField(
                t('lists.create.titleLabel'),
                Embed(
                  <TextFieldInput
                    label={t('lists.create.titleLabel')}
                    value={title}
                    onChangeText={setTitle}
                    placeholder={t('lists.create.titlePlaceholder')}
                  />,
                ),
              ),
              LField(
                t('lists.create.descriptionLabel'),
                Embed(
                  <Textarea
                    value={description}
                    onChangeText={setDescription}
                    placeholder={t('lists.create.descriptionPlaceholder')}
                    rows={3}
                  />,
                ),
              ),
              HStack(
                RawText(t('lists.create.publicLabel'))
                  .font('14')
                  .leading('20px')
                  .foreground('muted'),
                Toggle([isPublic, setIsPublic]).label(t('lists.create.publicLabel')),
              )
                .align('center')
                .justify('between'),
              Embed(
                <Field label={t('lists.create.addMembers')} style={{ marginTop: 12 }}>
                  <Search
                    label={t('lists.create.searchUsersPlaceholder')}
                    value={search}
                    onChangeText={doSearch}
                    onClearText={() => doSearch('')}
                  />
                </Field>,
              ),
            )
              .spacing('md')
              .margin('bottom', '10'),
            results.length > 0
              ? LCard(
                  Embed(
                    results.map((u, index) => (
                      <React.Fragment key={u.id}>
                        {index > 0 && toElement(LDivider())}
                        <TouchableOpacity style={touchables.resultRow} onPress={() => addMember(u)}>
                          {toElement(
                            RawText('@', u.username, ' • ', u.name.displayName).foreground(
                              'foreground',
                            ),
                          )}
                          {toElement(
                            RawText(t('lists.create.add')).foreground('primary').weight('semibold'),
                          )}
                        </TouchableOpacity>
                      </React.Fragment>
                    )),
                  ),
                )
                  .style('outline')
                  .radius('md')
              : null,
            members.length > 0
              ? VStack(
                  RawText(t('lists.create.members'))
                    .font('14')
                    .leading('20px')
                    .foreground('muted')
                    .margin('bottom', '6'),
                  Embed(
                    members.map((m) =>
                      toElement(
                        HStack(
                          RawText('@', m.username).foreground('foreground'),
                          Embed(
                            <TouchableOpacity onPress={() => removeMember(m.id)}>
                              {toElement(
                                RawText(t('lists.create.remove'))
                                  .foreground('destructive')
                                  .margin('left', '10'),
                              )}
                            </TouchableOpacity>,
                          ),
                        )
                          .padding('vertical', '6')
                          .align('center'),
                        m.id,
                      ),
                    ),
                  ),
                ).margin('top', '10')
              : null,
            Embed(
              <TouchableOpacity
                disabled={saving || !title.trim()}
                onPress={onCreate}
                style={[
                  touchables.create,
                  { backgroundColor: colors.primary },
                  !title.trim() && { opacity: 0.6 },
                ]}
              >
                {toElement(
                  RawText(saving ? t('lists.create.saving') : t('lists.create.createButton'))
                    .foreground('onPrimary')
                    .weight('bold'),
                )}
              </TouchableOpacity>,
            ),
          ).contentMargins('lg'),
        )}
      </SignInRequired>
    </Screen>
  );
}

export default function AvailableCreateListScreen() {
  return (
    <SupervisedFeatureGate>
      <CreateListScreen />
    </SupervisedFeatureGate>
  );
}
