import type { NestedPostRenderer } from "../Post/Attachments/PostAttachmentNested";
import type { FeedPostSlice } from "@mention/shared-types/feed";
import type { PostUser } from "@mention/shared-types/post";
import type { HydratedPost } from "@mention/shared-types/post";
import type { ComposedView } from "@oxy.so/bloom-language";
interface PostItemContentProps {
  readonly post: HydratedPost;
  readonly isNested?: boolean | undefined;
  readonly showPinned?: boolean | undefined;
  readonly style?: object | undefined;
  readonly onReply?: (() => void) | undefined;
  readonly nestingDepth?: number | undefined;
  readonly isThreadParent?: boolean | undefined;
  readonly isThreadChild?: boolean | undefined;
  readonly isThreadLastChild?: boolean | undefined;
  readonly replyBranch?: boolean | undefined;
  readonly attachedBelow?: boolean | undefined;
  readonly hideSeparator?: boolean | undefined;
  readonly repostedBy?: PostUser | undefined;
  readonly repostPlacement?: ("headOnly" | "shownAbove") | undefined;
  readonly socialContext?: FeedPostSlice['socialContext'] | undefined;
  readonly isPostDetail?: boolean | undefined;
  readonly threadPosition?: { index: number; total: number } | undefined;
  readonly feedDescriptor?: string | undefined;
  readonly sliceKey?: string | undefined;
  readonly threadOpenId?: string | undefined;
  readonly isThread?: boolean | undefined;
  readonly onOpen?: (() => void) | undefined;
  readonly openPostEngagement?: ((postId: string, kind: "likes" | "boosts" | "insights" | "replies", options?: Parameters<(NonNullable<Parameters<(NestedPostRenderer)>[2]>)>[2]) => boolean) | undefined;
}
/** A Bloom view: a node factory, not a JSX component. Use it in a chain (`VStack(PostItemContent())`), or from TSX as `toElement(PostItemContent())`. */
declare const PostItemContent: (props: PostItemContentProps) => ComposedView;
export declare const PostItem: typeof PostItemContent;
