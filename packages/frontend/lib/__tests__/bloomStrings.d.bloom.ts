import type { ComposedView } from "@oxy.so/bloom-language";
export declare function bloomString(key: string, args: Readonly<Record<string, string>>, count: number | undefined): string;
/** A Bloom view: a node factory, not a JSX component. Use it in a chain (`VStack(LoadingLabel())`), or from TSX as `toElement(LoadingLabel())`. */
export declare const LoadingLabel: () => ComposedView;
