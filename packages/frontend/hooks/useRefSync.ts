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
