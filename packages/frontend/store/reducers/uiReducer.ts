import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface Notification {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message?: string;
  duration?: number;
}

interface Modal {
  id: string;
  type: 'compose' | 'profile' | 'confirm' | 'image' | 'custom';
  data?: any;
  isVisible: boolean;
}

interface UIState {
  // Global loading states
  isAppLoading: boolean;
  
  // Notifications
  notifications: Notification[];
  
  // Modals
  modals: Modal[];
  
  // Navigation
  currentRoute: string;
  
  // Theme and layout
  colorScheme: 'light' | 'dark' | 'auto';
  sidebarCollapsed: boolean;
  
  // Compose modal
  isComposeModalOpen: boolean;
  composeReplyTo?: string;
  
  // Search
  searchQuery: string;
  searchResults: any[];
  isSearching: boolean;
  
  // Keyboard visibility (mobile)
  keyboardVisible: boolean;
}

const initialState: UIState = {
  isAppLoading: false,
  notifications: [],
  modals: [],
  currentRoute: '/',
  colorScheme: 'auto',
  sidebarCollapsed: false,
  isComposeModalOpen: false,
  searchQuery: '',
  searchResults: [],
  isSearching: false,
  keyboardVisible: false,
};

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    // App loading
    setAppLoading: (state, action: PayloadAction<boolean>) => {
      state.isAppLoading = action.payload;
    },
    
    // Notifications
    addNotification: (state, action: PayloadAction<Omit<Notification, 'id'>>) => {
      const notification: Notification = {
        ...action.payload,
        id: Date.now().toString(),
      };
      state.notifications.push(notification);
    },
    removeNotification: (state, action: PayloadAction<string>) => {
      state.notifications = state.notifications.filter(n => n.id !== action.payload);
    },
    clearNotifications: (state) => {
      state.notifications = [];
    },
    
    // Modals
    openModal: (state, action: PayloadAction<Omit<Modal, 'id' | 'isVisible'>>) => {
      const modal: Modal = {
        ...action.payload,
        id: Date.now().toString(),
        isVisible: true,
      };
      state.modals.push(modal);
    },
    closeModal: (state, action: PayloadAction<string>) => {
      const modalIndex = state.modals.findIndex(m => m.id === action.payload);
      if (modalIndex !== -1) {
        state.modals[modalIndex].isVisible = false;
      }
    },
    removeModal: (state, action: PayloadAction<string>) => {
      state.modals = state.modals.filter(m => m.id !== action.payload);
    },
    closeAllModals: (state) => {
      state.modals.forEach(modal => {
        modal.isVisible = false;
      });
    },
    
    // Navigation
    setCurrentRoute: (state, action: PayloadAction<string>) => {
      state.currentRoute = action.payload;
    },
    
    // Theme and layout
    setColorScheme: (state, action: PayloadAction<'light' | 'dark' | 'auto'>) => {
      state.colorScheme = action.payload;
    },
    toggleSidebar: (state) => {
      state.sidebarCollapsed = !state.sidebarCollapsed;
    },
    setSidebarCollapsed: (state, action: PayloadAction<boolean>) => {
      state.sidebarCollapsed = action.payload;
    },
    
    // Compose modal
    openComposeModal: (state, action: PayloadAction<{ replyTo?: string } | undefined>) => {
      state.isComposeModalOpen = true;
      state.composeReplyTo = action.payload?.replyTo;
    },
    closeComposeModal: (state) => {
      state.isComposeModalOpen = false;
      state.composeReplyTo = undefined;
    },
    
    // Search
    setSearchQuery: (state, action: PayloadAction<string>) => {
      state.searchQuery = action.payload;
    },
    setSearchResults: (state, action: PayloadAction<any[]>) => {
      state.searchResults = action.payload;
    },
    setSearching: (state, action: PayloadAction<boolean>) => {
      state.isSearching = action.payload;
    },
    clearSearch: (state) => {
      state.searchQuery = '';
      state.searchResults = [];
      state.isSearching = false;
    },
    
    // Keyboard
    setKeyboardVisible: (state, action: PayloadAction<boolean>) => {
      state.keyboardVisible = action.payload;
    },
  },
});

export const {
  setAppLoading,
  addNotification,
  removeNotification,
  clearNotifications,
  openModal,
  closeModal,
  removeModal,
  closeAllModals,
  setCurrentRoute,
  setColorScheme,
  toggleSidebar,
  setSidebarCollapsed,
  openComposeModal,
  closeComposeModal,
  setSearchQuery,
  setSearchResults,
  setSearching,
  clearSearch,
  setKeyboardVisible,
} = uiSlice.actions;

export default uiSlice.reducer; 