import type { LaneSummary } from "@mention/shared-types";
import type { ComposedView } from "@oxy.so/bloom-language";
export interface PostLaneChipProps {
  readonly lane: LaneSummary;
  readonly authorHandle: string;
  readonly feedDescriptor?: string | undefined;
}
/** A Bloom view: a node factory, not a JSX component. Use it in a chain (`VStack(PostLaneChip())`), or from TSX as `toElement(PostLaneChip())`. */
export declare const PostLaneChip: (props: PostLaneChipProps) => ComposedView;
export default PostLaneChip;
