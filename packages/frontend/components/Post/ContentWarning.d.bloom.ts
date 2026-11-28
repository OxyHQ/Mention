import type { ComposedView } from "@oxy.so/bloom-language";
export interface ContentWarningProps {
  readonly text: string;
  readonly revealed: boolean;
  readonly onToggle: () => void;
}
/** A Bloom view: a node factory, not a JSX component. Use it in a chain (`VStack(ContentWarning())`), or from TSX as `toElement(ContentWarning())`. */
export declare const ContentWarning: (props: ContentWarningProps) => ComposedView;
export default ContentWarning;
