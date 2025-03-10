# OxyHQ Services Module

A comprehensive module for interacting with the OxyHQ platform APIs. This module provides authentication, profile management, file handling, and other services.

## Features

- 🔐 **Authentication**: Complete authentication flow with token management
- 👤 **Profile Management**: User profile creation, retrieval, and updates
- 📁 **File Handling**: Upload, download, and manage files
- 💳 **Payments**: Process payments and manage subscriptions
- 🔄 **Caching**: Efficient data caching for improved performance
- 🔌 **Offline Support**: Graceful handling of offline scenarios
- 📊 **Analytics**: User activity tracking and reporting
- 🚀 **Performance Optimized**: Lazy loading, request deduplication, and more

## Installation

```bash
npm install @oxyhq/services
```

## Quick Start

```typescript
import { initialize, authService, oxyClient } from '@oxyhq/services';

// Initialize the module with custom configuration
initialize({
  apiUrl: 'https://api.your-instance.oxy.so',
  enableLogging: true,
  logLevel: 'debug'
});

// Use the authentication service
const login = async () => {
  try {
    const result = await authService.login({
      email: 'user@example.com',
      password: 'password123'
    });
    console.log('Logged in successfully', result.user);
  } catch (error) {
    console.error('Login failed', error);
  }
};

// Get a user profile
const getProfile = async (userId) => {
  try {
    const profile = await oxyClient.getProfile(userId);
    console.log('Profile retrieved', profile);
  } catch (error) {
    console.error('Failed to get profile', error);
  }
};
```

## Architecture

The OxyHQ Services module is built with a focus on performance, maintainability, and developer experience. Key architectural features include:

### Service Layer

The module is organized into specialized services, each responsible for a specific domain:

- **ApiService**: Core HTTP client with caching, retry logic, and token management
- **AuthService**: Authentication and session management
- **OxyClient**: High-level client for OxyHQ platform features
- **ProfileService**: User profile management
- **PaymentService**: Payment processing
- **SubscriptionService**: Subscription management
- **PrivacyService**: Privacy settings management

### Lazy Loading

Services are lazy-loaded to minimize initial bundle size and improve startup performance. The module exports getter functions that instantiate services only when needed:

```typescript
import { getAuthService, getOxyClient } from '@oxyhq/services';

// Service is instantiated only when called
const auth = getAuthService();
```

### Caching System

The module includes a sophisticated caching system to minimize network requests:

- **In-memory Cache**: Fast access to recently used data
- **Persistent Cache**: Data is stored for offline access
- **Cache Invalidation**: Automatic and manual cache invalidation strategies
- **TTL Support**: Time-based expiration for cached items

### Error Handling

Comprehensive error handling with:

- **Error Normalization**: Consistent error format across services
- **Retry Logic**: Automatic retry for transient failures
- **Offline Detection**: Graceful handling of network unavailability
- **Detailed Logging**: Contextual error information for debugging

### Logging

A centralized logging system with:

- **Log Levels**: DEBUG, INFO, WARN, ERROR, FATAL
- **Context Support**: Logs include contextual information
- **Remote Logging**: Optional sending of logs to a remote server
- **Performance Metrics**: Timing of operations for performance analysis
- **Sensitive Data Redaction**: Automatic redaction of sensitive information

## API Reference

### Core Services

#### ApiService

Low-level HTTP client with caching, retry logic, and token management.

```typescript
import { apiService } from '@oxyhq/services';

// GET request with caching
const data = await apiService.get('/endpoint', { 
  useCache: true,
  cacheTTL: 5 * 60 * 1000 // 5 minutes
});

// POST request
const result = await apiService.post('/endpoint', { data: 'value' });

// Cancel requests
apiService.cancelAllRequests();
```

#### OxyClient

High-level client for OxyHQ platform features.

```typescript
import { oxyClient } from '@oxyhq/services';

// Get user profile
const profile = await oxyClient.getProfile('user-id');

// Get file data
const files = await oxyClient.getFilesData(['file-id-1', 'file-id-2']);

// Get recommendations
const recommendations = await oxyClient.getRecommendations(10);
```

### Authentication

```typescript
import { authService } from '@oxyhq/services';

// Login
const loginResult = await authService.login({
  email: 'user@example.com',
  password: 'password123'
});

// Register
const registerResult = await authService.register({
  username: 'newuser',
  email: 'newuser@example.com',
  password: 'password123'
});

// Logout
await authService.logout();

// Check if user is authenticated
const isAuthenticated = await authService.isAuthenticated();
```

### User Management

```typescript
import { userService } from '@oxyhq/services';

// Get current user
const currentUser = await userService.getCurrentUser();

// Update user profile
await userService.updateProfile({
  name: {
    first: 'John',
    last: 'Doe'
  },
  avatar: 'avatar-url'
});

// Follow a user
await userService.followUser('user-id-to-follow');

// Unfollow a user
await userService.unfollowUser('user-id-to-unfollow');
```

### File Management

```typescript
import { useFiles } from '@oxyhq/services';

// In a React component
function MyComponent() {
  const { 
    uploadFile, 
    deleteFile, 
    getFileUrl, 
    isUploading 
  } = useFiles();

  const handleUpload = async (file) => {
    const fileId = await uploadFile(file);
    console.log('File uploaded with ID:', fileId);
  };

  return (
    <div>
      <input type="file" onChange={(e) => handleUpload(e.target.files[0])} />
      {isUploading && <p>Uploading...</p>}
    </div>
  );
}
```

### Configuration

The module can be configured using the `initialize` function:

```typescript
import { initialize } from '@oxyhq/services';

initialize({
  apiUrl: 'https://api.custom-instance.oxy.so',
  cloudUrl: 'https://files.custom-instance.oxy.so',
  enableLogging: true,
  logLevel: 'debug',
  enableOfflineMode: true
});
```

## Advanced Usage

### Custom Error Handling

```typescript
import { errorHandler } from '@oxyhq/services';

try {
  // Your code
} catch (error) {
  errorHandler.handleError(error, {
    context: 'Custom operation',
    fallbackMessage: 'Operation failed',
    showToast: true,
    onAuthError: () => {
      // Handle authentication errors
    }
  });
}
```

### Performance Logging

```typescript
import { logger } from '@oxyhq/services';

const performOperation = async () => {
  const startTime = Date.now();
  
  try {
    // Perform operation
    await someExpensiveOperation();
  } finally {
    // Log performance metrics
    logger.logPerformance('someExpensiveOperation', startTime, 'MyComponent');
  }
};
```

### Scoped Logging

```typescript
import { logger } from '@oxyhq/services';

// Create a logger scoped to a specific context
const componentLogger = logger.createScopedLogger('MyComponent');

componentLogger.info('Component initialized');
componentLogger.error('Error in component', { details: 'error details' });
```

## Contributing

We welcome contributions to the OxyHQ Services module! Please see our [Contributing Guide](CONTRIBUTING.md) for more information.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.