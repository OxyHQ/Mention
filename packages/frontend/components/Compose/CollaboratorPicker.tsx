import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import type React from 'react';
import { useState, useEffect } from 'react';
import { FlatList, TextInput, type TextStyle } from 'react-native';
import { useAuth } from '@oxy.so/services/ui/client';
import { AccountAvatar } from '@/components/ui/AccountAvatar';
import type { AccountKind, AvatarCharacter } from '@oxy.so/contracts';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { useColorTokens } from '@oxy.so/bloom/theme';
import { MAX_POST_COLLABORATORS, MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { useTranslation } from 'react-i18next';
import { logger } from '@oxy.so/core/logger';
import { displayNameOrHandle } from '@/utils/displayName';

import { Embed, HStack, Icon, RawText, VStack, toElement } from '@oxy.so/bloom-language';
export interface CollaboratorUser {
  id: string;
  username: string;
  displayName?: string;
  avatar?: string;
  kind?: AccountKind;
  character?: AvatarCharacter;
  color?: string | null;
}

interface CollaboratorPickerProps {
  selected: CollaboratorUser[];
  onChange: (users: CollaboratorUser[]) => void;
  /**
   * Whether the search field is open. Owned by the composer, because the control
   * that opens it is the people icon in the attachment row — the same row every
   * other attachment is added from — not a link inside this component.
   */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  disabled?: boolean;
}

const CollaboratorPicker: React.FC<CollaboratorPickerProps> = ({
  selected,
  onChange,
  expanded,
  onExpandedChange,
  disabled,
}) => {
  const { t } = useTranslation();
  const colorTokens = useColorTokens();
  const { oxyServices, user } = useAuth();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CollaboratorUser[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const search = async () => {
      if (!query || query.length < 1) {
        setResults([]);
        return;
      }
      setLoading(true);
      try {
        const { data: searchResults } = await oxyServices.users.search(query, { limit: 10 });
        const mapped: CollaboratorUser[] = (searchResults || []).flatMap(
          (profile: {
            id?: string;
            _id?: string;
            username?: string;
            handle?: string;
            name?: { displayName?: string };
            avatar?: string | null;
            kind?: AccountKind;
            character?: AvatarCharacter;
            color?: string | null;
          }) => {
            const username = profile.username || profile.handle || '';
            const id = profile.id || profile._id || '';
            if (!username || !id) return [];
            return [
              {
                id,
                username,
                displayName: profile.name?.displayName,
                avatar: profile.avatar || undefined,
                kind: profile.kind,
                character: profile.character,
                color: profile.color,
              },
            ];
          },
        );
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

  const closeSearch = () => {
    onExpandedChange(false);
    setQuery('');
    setResults([]);
  };

  const addUser = (collaborator: CollaboratorUser) => {
    if (selectedIds.has(collaborator.id)) return;
    if (selected.length >= MAX_POST_COLLABORATORS) return;
    onChange([...selected, collaborator]);
    setQuery('');
    setResults([]);
    // The last slot just filled: the search field it would render into is gone,
    // so leaving `expanded` true would strand the composer in a state the icon
    // has to be pressed twice to leave.
    if (selected.length + 1 >= MAX_POST_COLLABORATORS) onExpandedChange(false);
  };

  const removeUser = (id: string) => {
    onChange(selected.filter((s) => s.id !== id));
  };

  if (disabled) return null;
  // Nothing chosen and nothing open: the people icon in the attachment row is
  // the entry point, so this block has nothing to say yet and takes no space.
  if (!expanded && selected.length === 0) return null;

  return toElement(
    VStack(
      selected.length > 0
        ? HStack(
            Embed(
              selected.map((collab) =>
                toElement(
                  HStack(
                    Embed(
                      <AccountAvatar
                        account={collab}
                        source={collab.avatar}
                        size={24}
                        variant={MEDIA_VARIANT_AVATAR}
                      />,
                    ),
                    RawText(displayNameOrHandle(collab.displayName, `@${collab.username}`))
                      .foreground('foreground')
                      .font('14')
                      .leading('20px')
                      .lines(1),
                    VStack(Icon(RiCloseCircleLine).size('18').foreground('muted'))
                      .onPress(() => removeUser(collab.id))
                      .hitSlop('md')
                      .pressFade(),
                  )
                    .padding('left', 'xs')
                    .padding('right', 'sm')
                    .padding('vertical', 'xs')
                    .background('surface')
                    .border('border', 'thin')
                    .corner('infinite')
                    .align('center')
                    .spacing('xs'),
                  collab.id,
                ),
              ),
            ),
          )
            .wrap()
            .spacing('sm')
            .margin('bottom', 'sm')
        : null,
      Embed(
        expanded &&
          selected.length < MAX_POST_COLLABORATORS &&
          toElement(
            VStack(
              HStack(
                Icon(RiSearchLine).size('18').foreground('muted'),
                Embed(
                  <TextInput
                    style={[SEARCH_INPUT, { color: colorTokens.foreground }]}
                    placeholder={t('collab.searchPlaceholder', {
                      defaultValue: 'Search people to collaborate with',
                    })}
                    placeholderTextColor="#888"
                    value={query}
                    onChangeText={setQuery}
                    autoFocus
                  />,
                ),
                VStack(Icon(RiCloseLine).size('md').foreground('muted'))
                  .role('button')
                  .label(
                    t('collab.closeSearch', {
                      defaultValue: 'Close collaborator search',
                    }),
                  )
                  .onPress(closeSearch)
                  .pressFade(),
              )
                .padding('horizontal', 'md')
                .padding('vertical', 'sm')
                .align('center')
                .spacing('sm'),
              Embed(
                loading ? (
                  toElement(
                    VStack(Embed(<ListSkeleton count={2} />))
                      .padding('all', 'md')
                      .align('center'),
                  )
                ) : (
                  <FlatList
                    data={results.filter((r) => !selectedIds.has(r.id))}
                    keyExtractor={(item) => item.id}
                    keyboardShouldPersistTaps="handled"
                    style={{ maxHeight: 200 }}
                    ListEmptyComponent={
                      query.length > 0
                        ? toElement(
                            RawText(t('collab.noResults', { defaultValue: 'No users found' }))
                              .padding('all', 'md')
                              .foreground('muted')
                              .font('14')
                              .leading('20px')
                              .textAlign('center'),
                          )
                        : undefined
                    }
                    renderItem={({ item }) =>
                      toElement(
                        HStack(
                          Embed(
                            <AccountAvatar
                              account={item}
                              source={item.avatar}
                              size={32}
                              variant={MEDIA_VARIANT_AVATAR}
                            />,
                          ),
                          VStack(
                            RawText(displayNameOrHandle(item.displayName, item.username))
                              .foreground('foreground')
                              .font('md')
                              .weight('medium'),
                            RawText('@', item.username)
                              .foreground('muted')
                              .font('14')
                              .leading('20px'),
                          ).flex('1'),
                        )
                          .padding('horizontal', 'md')
                          .padding('vertical', 'sm')
                          .align('center')
                          .spacing('md')
                          .onPress(() => addUser(item))
                          .pressFade(),
                      )
                    }
                  />
                ),
              ),
            )
              .background('card')
              .border('border', 'thin')
              .corner('md')
              .clipped(),
          ),
      ),
    )
      .padding('horizontal', 'lg')
      .padding('bottom', 'sm'),
  );
};

/** The search field takes the row's room (`flex-1 text-[15px]`). */
const SEARCH_INPUT = {
  flexGrow: 1,
  flexShrink: 1,
  flexBasis: '0%',
  fontSize: 15,
} satisfies TextStyle;

export default CollaboratorPicker;
