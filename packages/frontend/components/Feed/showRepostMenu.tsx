import type { TFunction } from 'i18next';
import { RiRepeat2Line } from '@oxy.so/bloom/icons/RiRepeat2Line';
import { RiDoubleQuotesL } from '@oxy.so/bloom/icons/RiDoubleQuotesL';
import { showActionMenu } from '@/components/common/ActionMenu';

import { Icon, toElement } from '@oxy.so/bloom-language';

// The menu's glyphs paint in the primary ink, as a bare Bloom icon does (the
// `text-foreground` class they carried never reached an icon's fill).
export function showRepostMenu({
  isBoosted,
  quotesDisabled,
  t,
  onRepost,
  onQuote,
}: {
  isBoosted: boolean;
  quotesDisabled: boolean;
  t: TFunction;
  onRepost: () => void;
  onQuote: () => void;
}) {
  showActionMenu({
    label: t('post.repostOptions', 'Repost options'),
    groups: [
      [
        {
          label: isBoosted ? t('post.undoRepost', 'Undo repost') : t('post.repost', 'Repost'),
          icon: toElement(Icon(RiRepeat2Line).size('md').foreground('primary')),
          onPress: onRepost,
        },
        ...(!quotesDisabled
          ? [
              {
                label: t('post.quote', 'Quote'),
                icon: toElement(Icon(RiDoubleQuotesL).size('md').foreground('primary')),
                onPress: onQuote,
              },
            ]
          : []),
      ],
    ],
  });
}
