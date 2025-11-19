import React, {
  createContext,
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { Z_INDEX } from '@/lib/constants';

/**
 * Portal Component
 * 
 * Allows rendering components outside the normal React tree hierarchy.
 * Useful for modals, overlays, and tooltips that need to appear above all other content.
 * 
 * @example
 * ```tsx
 * <PortalProvider>
 *   <App />
 *   <PortalOutlet />
 * </PortalProvider>
 * 
 * // Elsewhere in the tree:
 * <Portal>
 *   <ModalContent />
 * </Portal>
 * ```
 */

type Component = React.ReactElement<any>;

type ContextType = {
  outlet: Component | null;
  append(id: string, component: Component): void;
  remove(id: string): void;
};

type ComponentMap = {
  [id: string]: Component | null;
};

function createPortalGroup() {
  const Context = createContext<ContextType>({
    outlet: null,
    append: () => {},
    remove: () => {},
  });
  Context.displayName = 'PortalContext';

  function Provider(props: React.PropsWithChildren<{}>) {
    const map = useRef<ComponentMap>({});
    const [outlet, setOutlet] = useState<ContextType['outlet']>(null);

    const append = useCallback<ContextType['append']>((id, component) => {
      if (map.current[id]) return;
      map.current[id] = <Fragment key={id}>{component}</Fragment>;
      setOutlet(<>{Object.values(map.current)}</>);
    }, []);

    const remove = useCallback<ContextType['remove']>((id) => {
      map.current[id] = null;
      setOutlet(<>{Object.values(map.current)}</>);
    }, []);

    const contextValue = useMemo(
      () => ({
        outlet,
        append,
        remove,
      }),
      [outlet, append, remove],
    );

    return (
      <Context.Provider value={contextValue}>
        {props.children}
      </Context.Provider>
    );
  }

  function Outlet() {
    const ctx = useContext(Context);

    // On web, wrap outlet in fixed-position container for full-screen rendering
    // This ensures Portal content appears above all other elements
    if (Platform.OS === 'web') {
      return (
        <View style={styles.portalOutlet}>
          {ctx.outlet}
        </View>
      );
    }

    // On native platforms, Modal handles positioning automatically
    return ctx.outlet;
  }

  function Portal({ children }: React.PropsWithChildren<{}>) {
    const { append, remove } = useContext(Context);
    const id = useId();

    useEffect(() => {
      append(id, children as Component);
      return () => remove(id);
    }, [id, children, append, remove]);

    return null;
  }

  return { Provider, Outlet, Portal };
}

const DefaultPortal = createPortalGroup();

export const Provider = DefaultPortal.Provider;
export const Outlet = memo(DefaultPortal.Outlet);
export const Portal = DefaultPortal.Portal;

const styles = StyleSheet.create({
  portalOutlet: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: 'box-none',
    zIndex: Z_INDEX.PORTAL_OUTLET,
  },
});

