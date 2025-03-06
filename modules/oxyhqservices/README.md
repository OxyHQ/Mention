# OxyHQ Services Module

This module provides authentication, profile management, file handling, and other services for interacting with the OxyHQ API in React Native applications.

## Features

- **Authentication**: Complete user authentication flow with login, registration, and session management
- **Profile Management**: User profile data handling and updates
- **File Handling**: Upload, selection, and management of user files
- **Subscriptions**: Subscription plan management and feature access
- **Settings Management**: User settings and preferences

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
  const { user, loginUser, logoutUser } = useAuth();
  
  if (user) {
    return <Button onPress={logoutUser}>Logout</Button>;
  }
  
  return <Button onPress={() => loginUser('username', 'password')}>Login</Button>;
}
```

### File Selection

```tsx
import { FileSelectorModal, useFiles } from '@/modules/oxyhqservices';
import { useState } from 'react';

function FileSelector() {
  const [isVisible, setIsVisible] = useState(false);
  const { files, uploadFiles } = useFiles({ 
    fileTypeFilter: ['image/'] 
  });
  
  const handleFileSelect = (selectedFiles) => {
    console.log('Selected files:', selectedFiles);
    setIsVisible(false);
  };
  
  return (
    <>
      <Button onPress={() => setIsVisible(true)}>Select Files</Button>
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

### Profile Management

```tsx
import { useProfile } from '@/modules/oxyhqservices';

function ProfileEditor() {
  const { getProfile, updateProfile, loading } = useProfile();
  
  const handleSave = async (profileData) => {
    try {
      await updateProfile(profileData);
      // Success!
    } catch (error) {
      // Handle error
    }
  };
  
  // Component implementation
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