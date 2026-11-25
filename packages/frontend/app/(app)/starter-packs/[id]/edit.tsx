import { FormSkeleton, ListSkeleton } from '@/components/loading/ContentSkeleton';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useLocalSearchParams } from '@/lib/navigation/router';
import { useScreenBack } from '@oxy.so/bloom/screen';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';

import { starterPacksService } from '@/services/starterPacksService';
import { confirmDestructive } from '@/utils/alerts';
import { displayNameOrHandle } from '@/utils/displayName';
import { logger } from '@oxy.so/core/logger';
import type { User } from '@oxy.so/core';

import {
  Avatar as LAvatar,
  Button as LButton,
  Card as LCard,
  Divider as LDivider,
  Embed,
  Field as LField,
  Header,
  HStack,
  Icon,
  RawText,
  Row,
  ScrollView,
  SpinnerIcon,
  TextEditor,
  TextField,
  Text as LText,
  toElement,
  VStack,
  Search as LSearch,
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
const MAX_MEMBERS = 150;

/**
 * Starter pack edit screen (owner only). Mirrors the list member editor at
 * `app/(app)/lists/[id]/edit.tsx`:
 * - name + description persist via `PUT /starter-packs/:id` on Save.
 * - members add/remove persist immediately via the dedicated member endpoints.
 * - the pack can be deleted (with a destructive confirm).
 *
 * Owner gating lives on the detail screen (the Edit entry point only shows for
 * the owner); this screen re-verifies ownership once the pack loads.
 */
export default screen(function EditStarterPackScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const packId = String(id);
  const { user, oxyServices } = useAuth();
  const back = useScreenBack();
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [savingDetails, setSavingDetails] = useState(false);
  const [members, setMembers] = useState<MemberProfile[]>([]);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<MemberProfile[]>([]);
  const [searching, setSearching] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const memberIdSet = useMemo(() => new Set(members.map((m) => m.id)), [members]);
  const atCapacity = members.length >= MAX_MEMBERS;
  const remainingCapacity = Math.max(MAX_MEMBERS - members.length, 0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const pack = await starterPacksService.get(packId);
      if (pack.ownerOxyUserId && user?.id && pack.ownerOxyUserId !== user.id) {
        setError('You can only edit your own starter packs');
        return;
      }
      setName(pack.name ?? '');
      setDescription(pack.description ?? '');
      // Members are hydrated server-side (identity + fully-resolved avatar URL);
      // the browser has no service credential for the bulk user lookup, so we
      // read them straight from the detail response instead of resolving ids.
      setMembers(
        (pack.members ?? []).map((m) => ({
          id: m.id,
          username: m.username,
          name: { displayName: displayNameOrHandle(m.displayName, m.username) },
          avatar: m.avatar ?? undefined,
        })),
      );
    } catch (e) {
      logger.warn('Failed to load starter pack for editing', { error: e });
      setError('Could not load this starter pack');
    } finally {
      setLoading(false);
    }
  }, [packId, user?.id]);

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

  const clearSearch = useCallback(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setSearch('');
    setResults([]);
    setSearching(false);
  }, []);

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
      if (members.length >= MAX_MEMBERS) {
        toast(`A starter pack can hold up to ${MAX_MEMBERS} accounts`, { type: 'error' });
        return;
      }
      setPending(profile.id, true);
      // Optimistic insert.
      setMembers((prev) => [profile, ...prev]);
      try {
        await starterPacksService.addMembers(packId, [profile.id]);
        toast(`Added @${profile.username}`, { type: 'success' });
      } catch (e) {
        logger.error('Add member failed', e);
        setMembers((prev) => prev.filter((m) => m.id !== profile.id));
        toast('Failed to add member', { type: 'error' });
      } finally {
        setPending(profile.id, false);
      }
    },
    [packId, memberIdSet, members.length, pendingIds, setPending],
  );

  const removeMember = useCallback(
    async (profile: MemberProfile) => {
      if (pendingIds.has(profile.id)) return;
      setPending(profile.id, true);
      // Optimistic removal.
      const previous = members;
      setMembers((prev) => prev.filter((m) => m.id !== profile.id));
      try {
        await starterPacksService.removeMembers(packId, [profile.id]);
        toast(`Removed @${profile.username}`, { type: 'success' });
      } catch (e) {
        logger.error('Remove member failed', e);
        setMembers(previous);
        toast('Failed to remove member', { type: 'error' });
      } finally {
        setPending(profile.id, false);
      }
    },
    [packId, members, pendingIds, setPending],
  );

  const saveDetails = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName || savingDetails) return;
    setSavingDetails(true);
    try {
      await starterPacksService.update(packId, {
        name: trimmedName,
        description: description.trim() || undefined,
        memberOxyUserIds: members.map((m) => m.id),
      });
      toast('Starter pack updated', { type: 'success' });
      back?.();
    } catch (e) {
      logger.error('Update starter pack failed', e);
      toast('Failed to update starter pack', { type: 'error' });
    } finally {
      setSavingDetails(false);
    }
  }, [packId, name, description, members, savingDetails, back]);

  const deletePack = useCallback(async () => {
    const confirmed = await confirmDestructive(
      'Delete starter pack?',
      'This permanently removes the pack. This cannot be undone.',
    );
    if (!confirmed) return;
    try {
      await starterPacksService.remove(packId);
      router.replace('/starter-packs');
    } catch (e) {
      logger.error('Failed to delete starter pack', e);
      toast('Failed to delete starter pack', { type: 'error' });
    }
  }, [packId, router]);

  const header = toElement(
    Header('Edit starter pack')
      .backLabel(t('common.back', { defaultValue: 'Back' }))
      .inPage(),
  );

  if (loading) {
    return ScrollView(Embed(<FormSkeleton />)).header(Embed(header));
  }

  if (error) {
    return ScrollView(
      Icon(RiCloseCircleLine).size('3xl').foreground('muted'),
      RawText(error).foreground('muted').font('16').leading('normal').textAlign('center'),
      Embed(
        toElement(
          VStack(
            Embed(
              toElement(
                RawText('Try again')
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
    )
      .contentView((v) =>
        v.padding('horizontal', '3xl').flex('1').align('center').justify('center').spacing('md'),
      )
      .header(Embed(header));
  }

  return ScrollView(
    VStack(
      LField(
        'Name',
        Embed(
          toElement(TextField([name, setName], 'Name').placeholder('e.g. Tech people to follow')),
        ),
      ),
      LField(
        'Description',
        Embed(
          toElement(
            TextEditor([description, setDescription])
              .placeholder('What is this starter pack about?')
              .rows(3),
          ),
        ),
      ),
      /* Add accounts: themed Bloom search field + result rows. The
                description carries the member count; at capacity the error
                replaces it and says why the field no longer accepts input. */ LField(
        'Add accounts',
        Embed(
          toElement(
            LSearch([search, runSearch])
              .label('Search people')
              .onClearText(clearSearch)
              .editable(!atCapacity),
          ),
        ),
      )
        .description(`${members.length}/${MAX_MEMBERS}`)
        .error(atCapacity ? 'This starter pack is full. Remove an account to add another.' : null),
    )
      .spacing('md')
      .margin('bottom', 'md'),
    Embed(
      searching &&
        toElement(
          HStack(
            Embed(<ListSkeleton count={2} />),
            RawText('Searching…').foreground('muted').font('xs').leading('16px'),
          )
            .align('center')
            .spacing('sm')
            .margin('top', '10'),
        ),
    ),
    results.length > 0 &&
      LCard(
        Embed(
          results.map((u, index) => {
            const already = memberIdSet.has(u.id);
            const busy = pendingIds.has(u.id);
            const blockedByCap = atCapacity && !already;
            return (
              <React.Fragment key={u.id}>
                {index > 0 && toElement(LDivider())}
                {toElement(
                  Row(u.name.displayName)
                    .leadingView(
                      LAvatar(u.avatar, {
                        variant: MEDIA_VARIANT_AVATAR,
                        name: u.name.displayName,
                      }).size('xl'),
                    )
                    .subtitle(`@${u.username}`)
                    .onPress(blockedByCap || already || busy ? undefined : () => addMember(u))
                    .label(
                      already ? `${u.name.displayName} already added` : `Add ${u.name.displayName}`,
                    )
                    .trailing(
                      already
                        ? LButton(
                            Icon(RiCheckLine).size('xs').foreground('success'),
                            LText('Added'),
                          )
                            .style('subtle')
                            .tint('neutral')
                            .size('sm')
                            .disabled(true)
                            .label(`${u.name.displayName} added`)
                        : LButton(Icon(RiAddLine).size('xs').foreground('onPrimary'), LText('Add'))
                            .style('solid')
                            .tint('accent')
                            .size('sm')
                            .loading(busy)
                            .disabled(blockedByCap)
                            .onPress(() => addMember(u))
                            .label(`Add ${u.name.displayName}`),
                    ),
                )}
              </React.Fragment>
            );
          }),
        ),
      )
        .outline('thin')
        .elevation('none')
        .radius('lg')
        .margin('top', '10'),
    /* Current members. */ HStack(
      RawText('Members (', members.length, ')')
        .font('14')
        .leading('20px')
        .foreground('foreground')
        .weight('semibold'),
      !atCapacity && members.length > 0
        ? RawText(remainingCapacity, ' ', remainingCapacity === 1 ? 'spot' : 'spots', ' left')
            .font('xs')
            .leading('16px')
            .foreground('muted')
        : null,
    )
      .align('center')
      .justify('between')
      .margin('top', 'xl')
      .margin('bottom', '6'),
    members.length === 0
      ? VStack(
          Icon(RiGroupLine).size('40').foreground('muted'),
          RawText('Search above to add people to this starter pack')
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
                    Row(m.name.displayName)
                      .leadingView(
                        LAvatar(m.avatar, {
                          variant: MEDIA_VARIANT_AVATAR,
                          name: m.name.displayName,
                        }).size('xl'),
                      )
                      .subtitle(`@${m.username}`)
                      .trailing(
                        LButton(Icon(RiDeleteBinLine).size('sm').foreground('error'))
                          .style('plain')
                          .tint('neutral')
                          .size('sm')
                          .loading(busy)
                          .onPress(() => removeMember(m))
                          .shape('circle')
                          .label(`Remove ${m.name.displayName}`),
                      ),
                  )}
                </React.Fragment>
              );
            }),
          ),
        )
          .outline('thin')
          .elevation('none')
          .radius('lg'),
    HStack(
      savingDetails ? SpinnerIcon().size('sm').tint('onPrimary') : null,
      RawText(savingDetails ? 'Saving...' : 'Save changes')
        .foreground('onPrimary')
        .weight('bold'),
    )
      .margin('top', 'xl')
      .padding('vertical', 'md')
      .align('center')
      .justify('center')
      .spacing('sm')
      .background('primary')
      .corner('10')
      .when(savingDetails || !name.trim(), (v) => v.opacity('60'))
      .disabled(savingDetails || !name.trim())
      .onPress(saveDetails)
      .role('button')
      .label('Save starter pack')
      .pressFade(),
    VStack(RawText('Delete starter pack').foreground('destructive').weight('semibold'))
      .margin('top', 'md')
      .padding('vertical', 'md')
      .align('center')
      .border('border', 'thin')
      .corner('10')
      .onPress(deletePack)
      .role('button')
      .label('Delete starter pack')
      .pressFade(),
  )
    .contentMargins('lg')
    .keyboardTaps('handled')
    .header(Embed(header));
});
