# OxyHQ Services Module

This module provides authentication, profile management, file handling, and other services for interacting with the OxyHQ API in React Native applications.

## Features

- **Authentication**: Complete user authentication flow with login, registration, and session management
- **Profile Management**: User profile data handling and updates
- **File Handling**: Upload, selection, and management of user files
- **Subscriptions**: Subscription plan management and feature access
- **Settings Management**: User settings and preferences

## Recent Improvements

### 1. Enhanced Authentication Security
- Improved token storage using secure storage methods
- Consistent use of STORAGE_KEYS constants for better maintainability
- Fixed authentication issues in file manager and socket connections

### 2. Better Error Handling
- Added centralized error handling utility (errorHandler.ts)
- Standardized error formats across the module
- Improved error logging with context information
- Added safe error handling patterns with the createSafeHandler utility

### 3. Improved Session Management
- Added session timeout detection for better security
- Implemented user activity tracking to prevent premature session expiration
- Enhanced session restoration with better error recovery
- Added isAuthenticated flag for easier auth state checking

### 4. File Management Enhancements
- Improved file caching for better performance
- Added sorting of files by upload date
- Better error handling and user feedback
- More efficient cache invalidation

### 5. Code Quality Improvements
- Fixed type definitions and linter errors
- Improved code organization and modularity
- Better documentation and comments
- More consistent coding patterns

## Installation

The module is included as part of the Mention application. No separate installation required.

## Usage

### Authentication

```tsx
import { SessionProvider, useAuth } from '@/modules/oxyhqservices';

// Wrap your app with the SessionProvider
function App() {
  return (
    <SessionProvider>
      <YourApp />
    </SessionProvider>
  );
}

// Use authentication hooks in your components
function LoginButton() {
  const { user, loginUser, logoutUser, isAuthenticated } = useAuth();
  
  if (isAuthenticated) {
    return <Button onPress={logoutUser}>Logout</Button>;
  }
  
  return <Button onPress={() => loginUser('username', 'password')}>Login</Button>;
}
```

### File Selection with Error Handling

```tsx
import { FileSelectorModal, useFiles, errorHandler } from '@/modules/oxyhqservices';
import { useState } from 'react';

function FileSelector() {
  const [isVisible, setIsVisible] = useState(false);
  const { files, uploadFiles, loading, error } = useFiles({ 
    fileTypeFilter: ['image/'] 
  });
  
  const handleFileSelect = (selectedFiles) => {
    console.log('Selected files:', selectedFiles);
    setIsVisible(false);
  };
  
  const handleUpload = async () => {
    try {
      await uploadFiles();
    } catch (error) {
      errorHandler.handleError(error, {
        context: 'FileUpload',
        fallbackMessage: 'Failed to upload files'
      });
    }
  };
  
  return (
    <>
      <Button onPress={() => setIsVisible(true)}>Select Files</Button>
      <Button onPress={handleUpload} disabled={loading}>Upload Files</Button>
      
      {error && <Text style={{ color: 'red' }}>{error}</Text>}
      
      <FileSelectorModal
        isVisible={isVisible}
        onClose={() => setIsVisible(false)}
        onSelect={handleFileSelect}
        options={{ maxFiles: 5 }}
      />
    </>
  );
}
```

### Safe API Calls

```tsx
import { errorHandler } from '@/modules/oxyhqservices';
import { useEffect, useState } from 'react';

function UserProfile({ userId }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    const fetchProfile = errorHandler.createSafeHandler(
      async (id) => {
        const response = await fetch(`/api/users/${id}`);
        return response.json();
      },
      {
        context: 'ProfileFetch',
        fallbackMessage: 'Could not load user profile'
      }
    );
    
    const loadProfile = async () => {
      setLoading(true);
      const [data, error] = await fetchProfile(userId);
      if (data) {
        setProfile(data);
      }
      setLoading(false);
    };
    
    loadProfile();
  }, [userId]);
  
  if (loading) return <LoadingSpinner />;
  if (!profile) return <Text>Could not load profile</Text>;
  
  return <ProfileView profile={profile} />;
}
```

## Error Handling

The new error handling utility provides several ways to handle errors:

```tsx
import { errorHandler } from '@/modules/oxyhqservices';

// Simple error handling with toast notification
try {
  await someAsyncFunction();
} catch (error) {
  errorHandler.handleError(error, {
    context: 'FunctionName',
    fallbackMessage: 'Operation failed'
  });
}

// Using the safe handler pattern
const safeFunction = errorHandler.createSafeHandler(
  async () => {
    // Your async code here
    return result;
  },
  {
    context: 'FunctionName',
    onError: (standardError) => {
      // Custom error handling
    }
  }
);

// Using the safe handler
const [result, error] = await safeFunction();
if (error) {
  // Handle error
} else {
  // Use result
}
```

## Component Reference

### Core Components

- `SessionProvider`: Manages authentication state and user sessions
- `AuthBottomSheet`: Authentication UI with login and signup
- `FileSelectorModal`: Modal UI for selecting user files
- `BaseBottomSheet`: Foundation component for bottom sheets
- `OxyLogo`: Brand logo component with customization options

### UI Components

- `Header`: Consistent header with title and navigation
- `FollowButton`: Button for following/unfollowing users
- `PaymentModal`: Modal for processing payments

## API Services

- `authService`: Authentication methods
- `profileService`: User profile methods
- `apiService`: Base API communication
- `userService`: User data and session management
- `subscriptionService`: Subscription plan management

## Architecture

The module follows a clean architecture pattern with:

- UI components in `/components`
- Business logic in `/services`
- State management with hooks in `/hooks`
- Shared types in `/types`
- Utility functions in `/utils`
- Global styles in `/styles`

## Contributing

When adding to this module, follow these guidelines:

1. Use the defined theme variables for consistent styling
2. Document component props and functions with JSDoc comments
3. Use TypeScript for all new code
4. Follow the established naming conventions
5. Add appropriate unit tests for new functionality

## License

This module is proprietary and part of the Mention application.