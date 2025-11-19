import React, { createContext, useContext, useMemo } from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';

/**
 * Grid Component
 * 
 * A flexible grid layout system for responsive layouts.
 * Reused from social-app and adapted for Mention's theme system.
 */

const GridContext = createContext({
  gap: 0,
});
GridContext.displayName = 'GridContext';

interface GridRowProps {
  children: React.ReactNode;
  gap?: number;
  style?: ViewStyle;
}

/**
 * Grid row container - provides gap context to children
 */
export function GridRow({ children, gap = 0, style }: GridRowProps) {
  const contextValue = useMemo(() => ({ gap }), [gap]);

  return (
    <GridContext.Provider value={contextValue}>
      <View
        style={[
          styles.row,
          {
            marginLeft: -gap / 2,
            marginRight: -gap / 2,
          },
          style,
        ]}>
        {children}
      </View>
    </GridContext.Provider>
  );
}

interface GridColProps {
  children: React.ReactNode;
  width?: number;
  style?: ViewStyle;
}

/**
 * Grid column - takes a portion of the row width
 */
export function GridCol({ children, width = 1, style }: GridColProps) {
  const { gap } = useContext(GridContext);

  return (
    <View
      style={[
        styles.col,
        {
          paddingLeft: gap / 2,
          paddingRight: gap / 2,
          width: `${width * 100}%`,
        },
        style,
      ]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flex: 1,
  },
  col: {
    flexDirection: 'column',
  },
});

