import type { TFunction } from "i18next";
import type { ComposedView } from "@oxy.so/bloom-language";
export interface Engagement {
  readonly replies: number | undefined;
  readonly likes: number | undefined;
  readonly boosts?: number | undefined;
  readonly downvotes?: number | undefined;
  readonly saves?: number | undefined;
}
export interface PostActionsProps {
  readonly presentation?: "post" | "video";
  readonly t: TFunction;
  readonly engagement: Engagement;
  readonly isLiked?: boolean | undefined;
  readonly isDownvoted?: boolean | undefined;
  readonly isBoosted?: boolean | undefined;
  readonly isSaved?: boolean | undefined;
  readonly onReply?: (() => void) | undefined;
  readonly onBoost: () => void;
  readonly onLike: () => boolean | undefined;
  readonly onDownvote?: (() => void) | undefined;
  readonly onSave: () => void;
  readonly onShare: () => void;
  readonly onSendInAllo?: (() => void) | undefined;
  readonly onInsightsPress?: (() => void) | undefined;
  readonly onTranslate?: (() => void) | undefined;
  readonly onTranslateLongPress?: (() => void) | undefined;
  readonly isTranslated?: boolean | undefined;
  readonly isTranslating?: boolean | undefined;
  readonly postId?: string | undefined;
}
/** A Bloom view: a node factory, not a JSX component. Use it in a chain (`VStack(PostActions())`), or from TSX as `toElement(PostActions())`. */
export declare const PostActions: (props: PostActionsProps) => ComposedView;
