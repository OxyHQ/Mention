import React from 'react';
import { useTranslation } from 'react-i18next';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { Link, type Href } from '@/lib/navigation/router';
import { ProfileHoverCard } from '../ProfileHoverCard';
import { CONTEXT_GLYPH_COLOR, contextRowTokens } from './postContextRowLayout';
import { Embed, HStack, Text as LText, VStack, toElement } from '@oxy.so/bloom-language';

/**
 * "in !technology@lemmy.world" — the community a federated post was written in.
 *
 * The post is its writer's: the byline is theirs and this row only says where
 * they posted it, the way Lemmy names a community (`!name@instance`). It links
 * to the community's profile, which lists its posts.
 */

interface Props {
  /** The community's canonical handle (`post.community`, normalized). */
  handle: string;
  /** Its profile, or null when it has no route. */
  href: Href | null;
  /** Colour for the leading glyph, from the active theme. */
  iconColor?: string;
}

const PostCommunityRow: React.FC<Props> = ({ handle, href }) => {
  const { t } = useTranslation();

  const label = LText(t('post.inCommunity', { handle }))
    .foreground('muted')
    .font('sm')
    .weight('semibold')
    .lines(1);

  // The hover card and the link each hand their props to the host they wrap.
  return toElement(
    Embed((render) => (
      <ProfileHoverCard username={handle}>
        {render(
          HStack(
            VStack(
              Embed(
                <RiGroupLine
                  width={13}
                  height={13}
                  fill="currentColor"
                  color={CONTEXT_GLYPH_COLOR}
                />,
              ),
            )
              .margin('left', '-lg')
              .margin('right', contextRowTokens.space.iconGap),
            href
              ? // The row lives inside the post's own press target: opening the
                // community must not open the post underneath it as well.
                Embed((renderLabel) => (
                  <Link href={href} push asChild onPress={(event) => event.stopPropagation()}>
                    {renderLabel(label)}
                  </Link>
                ))
              : label,
          )
            .align('center')
            .frame({ height: contextRowTokens.space.row }),
        )}
      </ProfileHoverCard>
    )),
  );
};

export default React.memo(PostCommunityRow);
