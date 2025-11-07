import { useRef, useEffect } from 'react';

/**
 * Custom hook to keep refs in sync with state values
 * Useful for accessing the latest state values in async callbacks or timeouts
 */
export const useRefSync = <T>(value: T) => {
  const ref = useRef(value);

  useEffect(() => {
    ref.current = value;
  }, [value]);

  return ref;
};

/**
 * Sync multiple values to refs at once
 * Returns an object with all the refs
 */
export const useMultiRefSync = <T extends Record<string, any>>(values: T): { [K in keyof T]: React.MutableRefObject<T[K]> } => {
  const refs = {} as { [K in keyof T]: React.MutableRefObject<T[K]> };

  for (const key in values) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    refs[key] = useRefSync(values[key]);
  }

  return refs;
};
