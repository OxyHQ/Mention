import type { BloomIcon } from '@/components/settings/RowIcon';
import { ThreadSortGroup } from '@/components/settings/ThreadSortGroup';
import { useThreadPreferencesStore, type VoteStyle } from '@/hooks/useThreadPreferences';
import { RiArrowUpSLine } from '@oxy.so/bloom/icons/RiArrowUpSLine';
import { RiHeartLine } from '@oxy.so/bloom/icons/RiHeartLine';
import { RadioIndicator } from '@oxy.so/bloom/radio-indicator';
import { useTranslation } from 'react-i18next';
import {
  Button as LButton,
  Embed,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  SettingsSection as LSettingsSection,
  Text,
  Toggle,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

const VOTE_STYLE_OPTIONS: {
  value: VoteStyle;
  icon: BloomIcon;
  labelKey: string;
  defaultLabel: string;
}[] = [
  {
    value: 'heart',
    icon: RiHeartLine,
    labelKey: 'settings.threadPreferences.voteStyleHeart',
    defaultLabel: 'Heart',
  },
  {
    value: 'pill',
    icon: RiArrowUpSLine,
    labelKey: 'settings.threadPreferences.voteStylePill',
    defaultLabel: 'Up/down vote',
  },
];

export default function ThreadPreferencesScreen() {
  const { t } = useTranslation();

  // All three preferences live in the one store, which owns persistence — so
  // every row reads and writes the same value, with no local copy to sync.
  const { treeView, voteStyle, setTreeView, setVoteStyle } = useThreadPreferencesStore();

  return toElement(
    VStack(
      VStack(
        Embed(
          <ThreadSortGroup
            title={t('settings.threadPreferences.sortReplies', {
              defaultValue: 'Sort replies',
            })}
          />,
        ),
        LSettingsSection(
          t('settings.threadPreferences.likeStyle', {
            defaultValue: 'Like style',
          }),
          LGroupedSection(
            Embed(
              VOTE_STYLE_OPTIONS.map((option) =>
                toElement(
                  LGroupedSectionItem(
                    t(option.labelKey, {
                      defaultValue: option.defaultLabel,
                    }),
                  )
                    .wrapControl()
                    .trailing(
                      Embed(
                        <>
                          {toElement(
                            LButton(Text(<RadioIndicator selected={voteStyle === option.value} />))
                              .size('sm')
                              .style('subtle')
                              .tint('neutral')
                              .onPress(() => setVoteStyle(option.value))
                              .label(
                                t(option.labelKey, {
                                  defaultValue: option.defaultLabel,
                                }),
                              ),
                          )}
                        </>,
                      ),
                    ),
                  option.value,
                ),
              ),
            ),
          ),
        ),
        LSettingsSection(
          t('settings.threadPreferences.display', {
            defaultValue: 'Display',
          }),
          LGroupedSection(
            LGroupedSectionItem(
              t('settings.threadPreferences.treeView', {
                defaultValue: 'Threaded tree view',
              }),
            )
              .wrapControl()
              .description(
                t('settings.threadPreferences.treeViewDesc', {
                  defaultValue: 'Show replies in a threaded tree structure',
                }),
              )
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([treeView, setTreeView]).label(
                        t('settings.threadPreferences.treeView', {
                          defaultValue: 'Threaded tree view',
                        }),
                      ),
                    )}
                  </>,
                ),
              ),
          ),
        ),
      ).spacing('lg'),
    ).spacing('lg'),
  );
}
