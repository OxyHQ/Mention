import React, { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import { useQueryClient } from '@tanstack/react-query';
import { starterPacksService } from '@/services/starterPacksService';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { logger } from '@oxy.so/core/logger';
import type { User } from '@oxy.so/core';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { SignInRequired } from '@/components/common/SignInRequired';
import {
  Divider as LDivider,
  Embed,
  Header,
  HStack,
  RawText,
  ScrollView,
  toElement,
  VStack,
  toElement as LtoElement,
} from '@oxy.so/bloom-language';
import { Card as LCard } from '@oxy.so/bloom-language/containers';
import {
  Field as LField,
  TextEditor,
  TextField,
  Search as LSearch,
} from '@oxy.so/bloom-language/inputs';

import { screen } from '@oxy.so/bloom-language/router';

type MinimalUser = Pick<User, 'id' | 'username' | 'name' | 'avatar'>;

export default screen(function CreateStarterPackScreen() {
  const router = useRouter();
  const { oxyServices, user } = useAuth();
  const { t } = useTranslation();
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
      toast.error(
        t('starterPacks.createFailed', { defaultValue: 'Could not create the starter pack' }),
      );
    } finally {
      setSaving(false);
    }
  }, [name, description, members, queryClient, user?.id, t, router]);

  return Embed(
    <SignInRequired
      label={t('starterPacks.signInRequired', { defaultValue: 'Sign in to use starter packs' })}
      description={t('starterPacks.signInRequiredDesc', {
        defaultValue: 'A starter pack is a set of accounts you recommend following together.',
      })}
    >
      {toElement(
        ScrollView(
          VStack(
            LField(
              'Name',
              Embed(
                toElement(
                  TextField([name, setName], 'Name').placeholder('e.g. Tech people to follow'),
                ),
              ),
            ),
            LField(
              'Description',
              Embed(
                toElement(
                  TextEditor([description, setDescription])
                    .placeholder(t('starterPacks.descriptionPlaceholder'))
                    .rows(3),
                ),
              ),
            ),
            LField(
              `Add accounts (${members.length}/150)`,
              Embed(
                LtoElement(
                  LSearch([search, doSearch])
                    .label(t('starterPacks.searchUsersPlaceholder'))
                    .onClearText(() => doSearch('')),
                ),
              ),
            ).margin('top', 'md'),
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
                          RawText('@', u.username, ' · ', u.name.displayName).foreground(
                            'foreground',
                          ),
                          RawText('Add').foreground('primary').weight('semibold'),
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
                RawText('Members')
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
                                  RawText('Remove').foreground('destructive').margin('left', '10'),
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
            RawText(saving ? 'Creating...' : 'Create Starter Pack')
              .foreground('onPrimary')
              .weight('bold'),
          )
            .margin('top', 'xl')
            .padding('vertical', 'md')
            .align('center')
            .background('primary')
            .corner('10')
            .when(!name.trim(), (v) => v.opacity('60'))
            .disabled(saving || !name.trim())
            .onPress(onCreate)
            .pressFade(),
        ).contentMargins('lg'),
      )}
    </SignInRequired>,
  ).header(
    Header(t('starterPacks.create'))
      .backLabel(t('common.back', { defaultValue: 'Back' }))
      .inPage(),
  );
});
