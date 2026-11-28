// `@oxy.so/app-preset/nativewind-theme` is plain CommonJS (the preset is a
// zero-build package) and ships no declaration: its one component, as
// `app/_layout.tsx` mounts it.
declare module '@oxy.so/app-preset/nativewind-theme' {
  import type { ReactElement, ReactNode } from 'react';

  export function BloomNativeWindTheme(props: { children: ReactNode }): ReactElement;
}
