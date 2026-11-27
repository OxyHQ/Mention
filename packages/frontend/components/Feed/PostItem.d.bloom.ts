import type { NestedPostRenderer } from "../Post/Attachments/PostAttachmentNested";
import type { FeedPostSlice } from "@mention/shared-types/feed";
import type { PostUser } from "@mention/shared-types/post";
import type { HydratedPost } from "@mention/shared-types/post";
import type { ComposedView } from "@oxy.so/bloom-language";
interface PostItemContentProps {
  readonly post: HydratedPost;
  readonly isNested?: boolean;
  readonly showPinned?: boolean;
  readonly style?: object | undefined | null;
  readonly onReply?: (() => void) | undefined | null;
  readonly nestingDepth?: number;
  readonly isThreadParent?: boolean;
  readonly isThreadChild?: boolean;
  readonly isThreadLastChild?: boolean;
  readonly replyBranch?: boolean;
  readonly attachedBelow?: boolean;
  readonly hideSeparator?: boolean;
  readonly repostedBy?: PostUser | undefined | null;
  readonly repostPlacement?: ("headOnly" | "shownAbove") | undefined | null;
  readonly socialContext?: FeedPostSlice['socialContext'] | undefined | null;
  readonly isPostDetail?: boolean | undefined | null;
  readonly threadPosition?: { index: number; total: number } | undefined | null;
  readonly feedDescriptor?: string | undefined | null;
  readonly sliceKey?: string | undefined | null;
  readonly threadOpenId?: string | undefined | null;
  readonly isThread?: boolean | undefined | null;
  readonly onOpen?: (() => void) | undefined | null;
  readonly openPostEngagement?: ((postId: string, kind: "likes" | "boosts" | "insights" | "replies", options?: Parameters<(NonNullable<Parameters<(NestedPostRenderer)>[2]>)>[2]) => boolean) | undefined | null;
}
/** A Bloom view: a node factory, not a JSX component. Use it in a chain (`VStack(PostItemContent())`), or from TSX as `toElement(PostItemContent())`. */
declare const PostItemContent: (props: PostItemContentProps) => ComposedView;
export declare const PostItem: typeof PostItemContent;
