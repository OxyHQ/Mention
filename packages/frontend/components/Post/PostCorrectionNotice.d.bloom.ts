import type { ComposedView } from "@oxy.so/bloom-language";
export interface PostCorrectionNoticeProps {
  readonly postId: string;
  readonly count: number;
}
/** A Bloom view: a node factory, not a JSX component. Use it in a chain (`VStack(PostCorrectionNotice())`), or from TSX as `toElement(PostCorrectionNotice())`. */
export declare const PostCorrectionNotice: (props: PostCorrectionNoticeProps) => ComposedView;
export default PostCorrectionNotice;
