import type { TFunction } from 'i18next';
import { RiRepeat2Line } from '@oxy.so/bloom/icons/RiRepeat2Line';
import { RiDoubleQuotesL } from '@oxy.so/bloom/icons/RiDoubleQuotesL';
import { showActionMenu } from '@/components/common/ActionMenu';

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
          icon: <RiRepeat2Line width={20} height={20} className="text-foreground" />,
          onPress: onRepost,
        },
        ...(!quotesDisabled
          ? [
              {
                label: t('post.quote', 'Quote'),
                icon: <RiDoubleQuotesL width={20} height={20} className="text-foreground" />,
                onPress: onQuote,
              },
            ]
          : []),
      ],
    ],
  });
}
