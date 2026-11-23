import { FormSkeleton, ListSkeleton } from '@/components/loading/ContentSkeleton';
import { SupervisedFeatureGate } from '@/components/SupervisedFeatureGate';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams } from '@/lib/navigation/router';
import { Search } from '@oxy.so/bloom/search';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { toast } from '@oxy.so/bloom/toast';
import { RiAlertLine } from '@oxy.so/bloom/icons/RiAlertLine';
import { RiCheckboxCircleFill } from '@oxy.so/bloom/icons/RiCheckboxCircleFill';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiIndeterminateCircleFill } from '@oxy.so/bloom/icons/RiIndeterminateCircleFill';
import { queryKeys } from '@oxy.so/services/ui/client';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';

import { listsService } from '@/services/listsService';
import { logger } from '@oxy.so/core/logger';
import { queryClient } from '@/lib/queryClient';
import type { User } from '@oxy.so/core';
import { displayNameOrHandle } from '@/utils/displayName';

import {
  Avatar as LAvatar,
  Card as LCard,
  Divider as LDivider,
  Embed,
  Field as LField,
  Header,
  HStack,
  Icon,
  RawText,
  ScrollView,
  SpinnerIcon,
  toElement,
  VStack,
  Embed as LEmbed,
} from '@oxy.so/bloom-language';

import { screen } from '@oxy.so/bloom-language/router';

interface MemberProfile {
  id: string;
  username: string;
  name: {
    displayName: string;
  };
  avatar?: string;
}

const SEARCH_DEBOUNCE_MS = 300;

/**
 * List member management screen. Resolves the broken `/lists/:id/edit` route that
 * the list detail screen ("Add people" / edit icon) navigates to.
 *
 * Owners search users and add/remove them. Each add/remove persists immediately
 * via `listsService.addMembers`/`removeMembers`, which broadcasts the change so
 * the list-backed feed (and the list detail screen) refresh automatically.
 */
const EditListMembersScreen = screen(function EditListMembersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const listId = String(id);
  const { oxyServices } = useAuth();
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberProfile[]>([]);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<MemberProfile[]>([]);
  const [searching, setSearching] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const memberIdSet = useMemo(() => new Set(members.map((m) => m.id)), [members]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listsService.get(listId);
      const memberIds: string[] = Array.isArray(data?.memberOxyUserIds)
        ? data.memberOxyUserIds
        : [];
      // Single bulk fetch (no per-id N+1); prime the shared React Query cache so
      // downstream profile reads for these members hit the cache.
      const fetched = await oxyServices.users.getMany(memberIds);
      for (const user of fetched) {
        if (user?.id) {
          queryClient.setQueryData(queryKeys.users.detail(user.id), user);
        }
      }
      const byId = new Map(fetched.map((user) => [user.id, user]));
      const profiles = memberIds
        .map((uid) => byId.get(uid))
        .filter((profile): profile is User => Boolean(profile))
        .map((profile) => ({
          id: profile.id,
          username: profile.username,
          name: { displayName: displayNameOrHandle(profile.name.displayName, profile.username) },
          avatar: profile.avatar ?? undefined,
        }));
      setMembers(profiles);
    } catch (e) {
      logger.warn('Failed to load list for editing', { error: e });
      setError(t('lists.edit.loadError', { defaultValue: 'Could not load this list' }));
    } finally {
      setLoading(false);
    }
  }, [listId, oxyServices, t]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    [],
  );

  const runSearch = useCallback(
    (q: string) => {
      setSearch(q);
      if (searchTimer.current) clearTimeout(searchTimer.current);
      const trimmed = q.trim();
      if (!trimmed) {
        setResults([]);
        setSearching(false);
        return;
      }
      setSearching(true);
      searchTimer.current = setTimeout(async () => {
        try {
          const res = await oxyServices.users.search(trimmed, { limit: 10 });
          setResults(
            res.data.map((profile: User) => ({
              id: profile.id,
              username: profile.username,
              name: {
                displayName: displayNameOrHandle(profile.name.displayName, profile.username),
              },
              avatar: profile.avatar ?? undefined,
            })),
          );
        } catch (e) {
          logger.warn('searchProfiles failed', { error: e });
          setResults([]);
        } finally {
          setSearching(false);
        }
      }, SEARCH_DEBOUNCE_MS);
    },
    [oxyServices],
  );

  const setPending = useCallback((uid: string, on: boolean) => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(uid);
      else next.delete(uid);
      return next;
    });
  }, []);

  const addMember = useCallback(
    async (profile: MemberProfile) => {
      if (memberIdSet.has(profile.id) || pendingIds.has(profile.id)) return;
      setPending(profile.id, true);
      // Optimistic insert.
      setMembers((prev) => [profile, ...prev]);
      try {
        await listsService.addMembers(listId, [profile.id]);
        toast(
          t('lists.edit.added', {
            user: profile.username,
            defaultValue: `Added @${profile.username}`,
          }),
          { type: 'success' },
        );
      } catch (e) {
        logger.error('Add member failed', e);
        setMembers((prev) => prev.filter((m) => m.id !== profile.id));
        toast(t('lists.edit.addFailed', { defaultValue: 'Failed to add member' }), {
          type: 'error',
        });
      } finally {
        setPending(profile.id, false);
      }
    },
    [listId, memberIdSet, pendingIds, setPending, t],
  );

  const removeMember = useCallback(
    async (profile: MemberProfile) => {
      if (pendingIds.has(profile.id)) return;
      setPending(profile.id, true);
      // Optimistic removal.
      const previous = members;
      setMembers((prev) => prev.filter((m) => m.id !== profile.id));
      try {
        await listsService.removeMembers(listId, [profile.id]);
        toast(
          t('lists.edit.removed', {
            user: profile.username,
            defaultValue: `Removed @${profile.username}`,
          }),
          { type: 'success' },
        );
      } catch (e) {
        logger.error('Remove member failed', e);
        setMembers(previous);
        toast(t('lists.edit.removeFailed', { defaultValue: 'Failed to remove member' }), {
          type: 'error',
        });
      } finally {
        setPending(profile.id, false);
      }
    },
    [listId, members, pendingIds, setPending, t],
  );

  const header = toElement(
    Header(t('lists.edit.title', { defaultValue: 'Edit members' }))
      .backLabel(t('common.back', { defaultValue: 'Back' }))
      .inPage(),
  );

  if (loading) {
    return LEmbed(toElement(ScrollView(Embed(<FormSkeleton />)))).header(LEmbed(header));
  }

  if (error) {
    return LEmbed(
      toElement(
        ScrollView(
          Icon(RiAlertLine).size('3xl').foreground('muted'),
          RawText(error).foreground('muted').font('16').leading('normal').textAlign('center'),
          Embed(
            toElement(
              VStack(
                Embed(
                  toElement(
                    RawText(t('common.retry', { defaultValue: 'Try again' }))
                      .foreground('primary')
                      .font('14')
                      .leading('20px')
                      .weight('semibold'),
                  ),
                ),
              )
                .onPress(load)
                .pressFade(),
            ),
          ),
        ).contentView((v) =>
          v.padding('horizontal', '3xl').flex('1').align('center').justify('center').spacing('md'),
        ),
      ),
    ).header(LEmbed(header));
  }

  return LEmbed(
    toElement(
      ScrollView(
        LField(
          t('lists.edit.addMembers', { defaultValue: 'Add members' }),
          Embed(
            <Search
              label={t('lists.create.searchUsersPlaceholder', { defaultValue: 'Search users' })}
              value={search}
              onChangeText={runSearch}
              onClearText={() => runSearch('')}
            />,
          ),
        ).margin('bottom', '10'),
        Embed(searching && <ListSkeleton count={2} />),
        results.length > 0 &&
          LCard(
            Embed(
              results.map((u, index) => {
                const already = memberIdSet.has(u.id);
                const busy = pendingIds.has(u.id);
                return (
                  <React.Fragment key={u.id}>
                    {index > 0 && toElement(LDivider())}
                    {toElement(
                      HStack(
                        LAvatar(u.avatar, { variant: MEDIA_VARIANT_AVATAR }).size('lg'),
                        VStack(
                          RawText('@', u.username)
                            .foreground('foreground')
                            .weight('medium')
                            .lines(1),
                          RawText(u.name.displayName)
                            .foreground('muted')
                            .font('xs')
                            .leading('16px')
                            .lines(1),
                        ).flex('1'),
                        busy
                          ? SpinnerIcon().size('18').tint('primary')
                          : already
                            ? Icon(RiCheckboxCircleFill).size('22').foreground('primary')
                            : RawText(t('lists.create.add', { defaultValue: 'Add' }))
                                .foreground('primary')
                                .weight('semibold'),
                      )
                        .align('center')
                        .spacing('md')
                        .padding('horizontal', 'md')
                        .padding('vertical', '10')
                        .disabled(already || busy)
                        .onPress(() => addMember(u))
                        .pressFade('70'),
                    )}
                  </React.Fragment>
                );
              }),
            ),
          )
            .style('outline')
            .radius('md')
            .margin('bottom', 'md'),
        RawText(
          members.length,
          ' ',
          members.length === 1
            ? t('lists.memberSingular', { defaultValue: 'member' })
            : t('lists.memberPlural', { defaultValue: 'members' }),
        )
          .font('14')
          .leading('20px')
          .foreground('muted')
          .margin('bottom', '6')
          .margin('top', 'xs'),
        members.length === 0
          ? VStack(
              Icon(RiGroupLine).size('44').foreground('muted'),
              RawText(
                t('lists.emptyMembersSubtext', {
                  defaultValue: 'Add people to curate this list',
                }),
              )
                .foreground('muted')
                .font('14')
                .leading('20px')
                .textAlign('center'),
            )
              .padding('vertical', '4xl')
              .align('center')
              .justify('center')
              .spacing('md')
          : LCard(
              Embed(
                members.map((m, index) => {
                  const busy = pendingIds.has(m.id);
                  return (
                    <React.Fragment key={m.id}>
                      {index > 0 && toElement(LDivider())}
                      {toElement(
                        HStack(
                          LAvatar(m.avatar, { variant: MEDIA_VARIANT_AVATAR }).size('lg'),
                          VStack(
                            RawText('@', m.username)
                              .foreground('foreground')
                              .weight('medium')
                              .lines(1),
                            RawText(m.name.displayName)
                              .foreground('muted')
                              .font('xs')
                              .leading('16px')
                              .lines(1),
                          ).flex('1'),
                          VStack(
                            busy
                              ? SpinnerIcon().size('18').tint('destructive')
                              : Icon(RiIndeterminateCircleFill).size('lg').foreground('error'),
                          )
                            .disabled(busy)
                            .onPress(() => removeMember(m))
                            .hitSlop('md')
                            .role('button')
                            .label(t('lists.create.remove', { defaultValue: 'Remove' }))
                            .pressFade(),
                        )
                          .padding('horizontal', 'md')
                          .padding('vertical', '10')
                          .align('center')
                          .spacing('md'),
                      )}
                    </React.Fragment>
                  );
                }),
              ),
            )
              .style('outline')
              .radius('md'),
      )
        .contentMargins('lg')
        .keyboardTaps('handled'),
    ),
  ).header(LEmbed(header));
});

export default function AvailableEditListMembersScreen() {
  return (
    <SupervisedFeatureGate>
      <EditListMembersScreen />
    </SupervisedFeatureGate>
  );
}
