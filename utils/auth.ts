import { BottomSheetContext } from '@/context/BottomSheetContext';

type BottomSheetContentFactory = () => React.ReactNode;

let bottomSheetContext: {
  setBottomSheetContent: (content: React.ReactNode) => void;
  openBottomSheet: (open: boolean) => void;
} | null = null;

let authBottomSheetFactory: BottomSheetContentFactory | null = null;

export const setBottomSheetContextRef = (context: typeof bottomSheetContext) => {
  bottomSheetContext = context;
};

export const setAuthBottomSheetFactory = (factory: BottomSheetContentFactory) => {
  authBottomSheetFactory = factory;
};

export const showAuthBottomSheet = () => {
  if (bottomSheetContext && authBottomSheetFactory) {
    const { setBottomSheetContent, openBottomSheet } = bottomSheetContext;
    setBottomSheetContent(authBottomSheetFactory());
    openBottomSheet(true);
  } else {
    console.error('BottomSheet context or auth factory not initialized');
  }
}; 