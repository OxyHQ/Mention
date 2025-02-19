# Mention Frontend Documentation

## Overview

Mention is a modern social media application built with React Native and Expo, providing a cross-platform experience for both mobile and web platforms. The application features a rich set of social interactions including posts, stories, real-time chat, notifications, and more.

## Tech Stack

- React Native / Expo
- TypeScript
- TailwindCSS (via NativeWind)
- Redux for state management
- Socket.IO for real-time features
- React Navigation

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn package manager
- Expo CLI
- iOS Simulator (for iOS development)
- Android Studio (for Android development)

## Getting Started

### Installation

1. Clone the repository
2. Install dependencies:
```bash
yarn install
```

3. Start the development server:
```bash
yarn start
```

4. Run on specific platforms:
```bash
# For iOS
yarn ios

# For Android
yarn android

# For Web
yarn web
```

## Project Structure

```
frontend/
├── app/                 # App screens and navigation
├── assets/             # Static assets (images, fonts, icons)
├── components/         # Reusable UI components
├── constants/         # App-wide constants
├── context/           # React Context providers
├── features/          # Feature-specific components and logic
├── hooks/             # Custom React hooks
├── interfaces/        # TypeScript interfaces
├── lib/               # Third-party library configurations
├── locales/           # Internationalization files
├── store/             # Redux store configuration
├── styles/            # Global styles and themes
├── utils/             # Utility functions and helpers
└── types/             # Global TypeScript type definitions
```

## Key Features

### Authentication
- Login and Signup screens
- Secure token management
- Persistent authentication state

### Feed
- Infinite scroll post feed
- Create and interact with posts
- Media upload support
- Like and comment functionality

### Profile
- User profiles with customizable information
- Follow/Unfollow functionality
- Activity history

### Real-time Features
- Live chat messaging
- Push notifications
- Story viewing

### Search and Discovery
- User search
- Hashtag exploration
- Trending content

## Component Architecture

### Core Components

- `Avatar` - User profile picture component
- `Button` - Customizable button component
- `Post` - Social media post display
- `Feed` - Infinite scroll post list
- `Header` - Screen header with navigation
- `BottomBar` - Mobile navigation bar
- `SideBar` - Web navigation sidebar

### Layout Components

- `ThemedView` - Themed container component
- `ThemedText` - Themed text component
- `Collapsible` - Expandable/collapsible content

## State Management

The application uses Redux for global state management:

```typescript
// Store structure
interface RootState {
  auth: AuthState;
  posts: PostsState;
  profile: ProfileState;
  ui: UIState;
}
```

## API Integration

API calls are managed through custom hooks and utility functions:

- `useAuth` - Authentication operations
- `useCache` - Client-side caching
- `api.ts` - REST API client
- `socket.ts` - WebSocket connections

## Styling

### Theme System

The app uses a dynamic theme system supporting light and dark modes:

```typescript
// Access theme colors
const colors = useThemeColor();
```

### TailwindCSS

Styling is primarily handled through TailwindCSS/NativeWind:

```typescript
// Example component styling
<View className="flex-1 bg-white dark:bg-gray-900">
  <Text className="text-lg font-bold text-gray-900 dark:text-white">
    Content
  </Text>
</View>
```

## Development Guidelines

### Code Style

- Follow TypeScript best practices
- Use functional components with hooks
- Implement proper error handling
- Write meaningful component documentation

### Performance Optimization

- Implement proper list virtualization
- Use memo and useMemo for expensive computations
- Optimize image loading and caching
- Minimize re-renders

### Testing

Run tests using:
```bash
yarn test
```

### Building for Production

```bash
# Build for iOS/Android
eas build

# Build for web
yarn build:web
```

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request

## Troubleshooting

### Common Issues

1. Metro bundler issues
```bash
# Clear metro cache
yarn start --clear
```

2. Dependencies issues
```bash
# Clean install dependencies
rm -rf node_modules
yarn install
```
