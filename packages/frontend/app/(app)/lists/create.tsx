import { SupervisedFeatureGate } from '@/components/SupervisedFeatureGate';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Field } from '@oxy.so/bloom/field';
import { Search } from '@oxy.so/bloom/search';
import { toast } from '@oxy.so/bloom/toast';
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
  Header,
  HStack,
  RawText,
  ScrollView,
  TextEditor,
  TextField,
  toElement,
  Toggle,
  VStack,
  Embed as LEmbed,
} from '@oxy.so/bloom-language';

import { screen } from '@oxy.so/bloom-language/router';

type MinimalUser = Pick<User, 'id' | 'username' | 'name' | 'avatar'>;

const CreateListScreen = screen(function CreateListScreen() {
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

  return LEmbed(
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
                toElement(
                  TextField([title, setTitle], t('lists.create.titleLabel')).placeholder(
                    t('lists.create.titlePlaceholder'),
                  ),
                ),
              ),
            ),
            LField(
              t('lists.create.descriptionLabel'),
              Embed(
                toElement(
                  TextEditor([description, setDescription])
                    .placeholder(t('lists.create.descriptionPlaceholder'))
                    .rows(3),
                ),
              ),
            ),
            HStack(
              RawText(t('lists.create.publicLabel')).font('14').leading('20px').foreground('muted'),
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
                      {toElement(
                        HStack(
                          RawText('@', u.username, ' • ', u.name.displayName).foreground(
                            'foreground',
                          ),
                          RawText(t('lists.create.add')).foreground('primary').weight('semibold'),
                        )
                          .justify('between')
                          .align('center')
                          .padding('horizontal', 'md')
                          .padding('vertical', '10')
                          .onPress(() => addMember(u))
                          .pressFade(),
                      )}
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
                          toElement(
                            VStack(
                              Embed(
                                toElement(
                                  RawText(t('lists.create.remove'))
                                    .foreground('destructive')
                                    .margin('left', '10'),
                                ),
                              ),
                            )
                              .onPress(() => removeMember(m.id))
                              .pressFade(),
                          ),
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
          VStack(
            RawText(saving ? t('lists.create.saving') : t('lists.create.createButton'))
              .foreground('onPrimary')
              .weight('bold'),
          )
            .margin('top', 'xl')
            .padding('vertical', 'md')
            .align('center')
            .background('primary')
            .corner('10')
            .when(!title.trim(), (v) => v.opacity('60'))
            .disabled(saving || !title.trim())
            .onPress(onCreate)
            .pressFade(),
        ).contentMargins('lg'),
      )}
    </SignInRequired>,
  ).header(
    LEmbed(
      toElement(
        Header(t('lists.create.title'))
          .backLabel(t('common.back', { defaultValue: 'Back' }))
          .inPage(),
      ),
    ),
  );
});

export default function AvailableCreateListScreen() {
  return (
    <SupervisedFeatureGate>
      <CreateListScreen />
    </SupervisedFeatureGate>
  );
}
