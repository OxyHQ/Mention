import { createContext, useContext, useEffect, useId, useMemo, useRef } from 'react';

import type { DialogContextProps, DialogControlRefProps, DialogControlProps } from './types';

export const Context = createContext<DialogContextProps>({
  close: () => {},
  isWithinDialog: false,
});
Context.displayName = 'DialogContext';

export function useDialogContext(): DialogContextProps {
  return useContext(Context);
}

export function useDialogControl(): DialogControlProps {
  const id = useId();
  const control = useRef<DialogControlRefProps | null>({
    open: () => {},
    close: () => {},
  });

  return useMemo<DialogControlProps>(
    () => ({
      id,
      ref: control,
      open: (options) => {
        control.current?.open(options);
      },
      close: (cb) => {
        control.current?.close(cb);
      },
    }),
    [id],
  );
}
