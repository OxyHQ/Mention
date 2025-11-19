import { useContext } from 'react';
import { Portal } from '@/components/Portal';
import { createContext } from 'react';

/**
 * usePortal Hook
 * 
 * Convenience hook for using Portal component.
 * Provides a simple API for rendering content outside the normal tree.
 */

interface UsePortalReturn {
  /**
   * Render content via Portal
   * @param children - Content to render in portal
   * @param show - Whether to show the portal content
   */
  render: (children: React.ReactNode, show?: boolean) => React.ReactNode;
}

/**
 * Hook to use Portal for rendering content outside tree
 * @param show - Whether portal should be active
 */
export function usePortal(show: boolean = true): UsePortalReturn {
  const render = (children: React.ReactNode, shouldShow: boolean = show) => {
    if (!shouldShow) return null;
    return <Portal>{children}</Portal>;
  };

  return { render };
}

/**
 * Hook that returns Portal component directly for conditional rendering
 */
export function usePortalComponent() {
  return Portal;
}

