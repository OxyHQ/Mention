import type { Href } from "@/lib/navigation/router";
import type { ComposedView } from "@oxy.so/bloom-language";
export interface PostCommunityRowProps {
  readonly handle: string;
  readonly href: Href | undefined;
  readonly iconColor?: string | undefined;
}
/** A Bloom view: a node factory, not a JSX component. Use it in a chain (`VStack(PostCommunityRow())`), or from TSX as `toElement(PostCommunityRow())`. */
export declare const PostCommunityRow: (props: PostCommunityRowProps) => ComposedView;
export default PostCommunityRow;
