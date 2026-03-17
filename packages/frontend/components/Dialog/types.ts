import { type GestureResponderEvent, type ScrollViewProps, type StyleProp, type ViewStyle } from 'react-native';

/**
 * Mutated by useImperativeHandle to provide a public API for controlling the
 * dialog. The methods here will actually become the handlers defined within
 * the `Dialog.Outer` component.
 */
export type DialogControlRefProps = {
  open: (options?: Partial<GestureResponderEvent>) => void;
  close: (callback?: () => void) => void;
};

/**
 * The return type of the useDialogControl hook.
 */
export type DialogControlProps = DialogControlRefProps & {
  id: string;
  ref: React.RefObject<DialogControlRefProps | null>;
};

export type DialogContextProps = {
  close: DialogControlProps['close'];
  isWithinDialog: boolean;
};

export type DialogOuterProps = {
  control: DialogControlProps;
  onClose?: () => void;
  testID?: string;
  /**
   * Web-only options.
   */
  webOptions?: {
    /** Center the dialog vertically on screen. */
    alignCenter?: boolean;
  };
  /**
   * Native-only: prevent the bottom sheet from expanding to full screen.
   */
  preventExpansion?: boolean;
};

export type DialogInnerProps = React.PropsWithChildren<{
  style?: StyleProp<ViewStyle>;
  label?: string;
  header?: React.ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  keyboardDismissMode?: ScrollViewProps['keyboardDismissMode'];
}>;
