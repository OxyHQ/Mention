import {
  present,
  presentCancelable,
  type CancelablePresentOptions,
  type PresentOptions,
  type SurfaceRenderFn,
} from '@oxy.so/bloom/surfaces';

function sheetOptions<T extends PresentOptions>(options: T): T {
  return { contentPadding: 0, ...options };
}

/**
 * Present a panel of Mention content on Bloom's one surface stack (the
 * `<SurfaceProvider>` OxyProvider mounts): a bottom sheet on narrow screens, a
 * centered card from `md` up. Mention's sheets lay out their own insets, so the
 * surface adds no padding of its own.
 *
 * The render function receives the surface's controls: content closes itself
 * with `surface.dismiss()`, and a sheet opened from inside another stacks above
 * it until it is dismissed.
 */
export function presentSheet<Result = unknown>(
  render: SurfaceRenderFn,
  options?: PresentOptions,
): Promise<Result> {
  return present<Result>(render, sheetOptions(options ?? {}));
}

/** Present one sheet that closes when its owner's signal aborts. */
export function presentCancelableSheet<Result = unknown>(
  render: SurfaceRenderFn,
  options: CancelablePresentOptions,
): Promise<Result | undefined> {
  return presentCancelable<Result>(render, sheetOptions(options));
}
