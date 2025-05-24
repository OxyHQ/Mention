# Oxy AI Development Instructions

These instructions are for AI assistants to develop applications using the Oxy ecosystem and services. Please follow these conventions and best practices when building apps that integrate with Oxy.

## Core Principles

**We use the Oxy Services SDK (`@oxyhq/services`) for all backend integrations**, not direct API calls. Always import and use the `OxyServices` class and related components from this package when building applications that integrate with the Oxy ecosystem.

**User authentication and management is handled through the Oxy ecosystem**, not custom user systems. Users exist in the Oxy platform (cloud.oxy.so by default) and your app integrates with this existing user base - you don't create separate user accounts for your app.

**All financial transactions go through the Oxy wallet system** using karma points and the built-in wallet infrastructure. Don't implement separate payment or currency systems.

## Authentication & User Management

```typescript
// Always use OxyProvider to wrap your app
import { OxyProvider } from '@oxyhq/services';

// Users authenticate through Oxy, not your app
const { user, login, logout, signUp, isAuthenticated } = useOxy();

// Check authentication status
if (isAuthenticated) {
  // User is logged into Oxy ecosystem
  console.log('Current user:', user.username);
}
```

**Important**: Users are Oxy platform users, not app-specific users. When a user signs into your app, they're signing into their existing Oxy account. Always use the Oxy authentication system.

## Code Conventions

**We use TypeScript exclusively** for all Oxy integrations and React Native/Expo for mobile development. Always provide proper TypeScript interfaces and type definitions.

**We use double quotes and 2-space indentation** for all JavaScript/TypeScript code in Oxy projects:

```typescript
import { OxyServices, User } from "@oxyhq/services";

const handleUserProfile = async (userId: string): Promise<User> => {
  const oxyServices = new OxyServices({ baseURL: "https://cloud.oxy.so" });
  return await oxyServices.getProfileByUsername(userId);
};
```

**We use Expo and React Native** for mobile development with Oxy services. Always structure mobile apps following Expo conventions and use the Oxy UI components when available.

## Service Integration

```typescript
// Initialize Oxy services
import { OxyServices, OXY_CLOUD_URL } from '@oxyhq/services';

const oxyServices = new OxyServices({
  baseURL: OXY_CLOUD_URL // or your custom Oxy instance
});

// Use the services throughout your app
const userProfile = await oxyServices.getProfileByUsername("username");
const karmaTotal = await oxyServices.getUserKarmaTotal(userId);
const wallet = await oxyServices.getWallet(userId);
```

## Karma System Integration

**Karma is the core reputation system in Oxy** - always integrate karma display and earning mechanisms in your apps:

```typescript
// Display user karma
const { total } = await oxyServices.getUserKarmaTotal(userId);

// Show karma history
const { history } = await oxyServices.getUserKarmaHistory(userId, 20, 0);

// Award karma for positive actions (admin/system only)
await oxyServices.awardKarma({
  userId: user.id,
  points: 10,
  reason: "Helped another user"
});
```

**Karma cannot be transferred between users** - it can only be earned through positive actions in the ecosystem.

## Wallet & Transactions

**All monetary transactions use the Oxy wallet system**:

```typescript
// Get user's wallet
const wallet = await oxyServices.getWallet(userId);

// Process purchases through Oxy
await oxyServices.processPurchase({
  userId: user.id,
  itemId: "item_123",
  amount: 100
});

// View transaction history
const { transactions } = await oxyServices.getTransactionHistory(userId);
```

## UI Components & Theming

**Use the built-in Oxy UI components** when building interfaces:

```typescript
import { 
  Avatar, 
  OxyLogo, 
  FollowButton,
  OxyProvider 
} from '@oxyhq/services';

// Always support both light and dark themes
const isDarkTheme = theme === 'dark';
const backgroundColor = isDarkTheme ? '#121212' : '#FFFFFF';
const textColor = isDarkTheme ? '#FFFFFF' : '#000000';
const primaryColor = '#d169e5'; // Oxy brand color
```

**Font Usage**: Use the Phudu font family for headings and brand elements:

```typescript
const styles = StyleSheet.create({
  title: {
    fontFamily: Platform.OS === 'web' ? 'Phudu' : 'Phudu-Bold',
    fontWeight: Platform.OS === 'web' ? 'bold' : undefined,
    fontSize: 24,
  }
});
```

## Navigation & Screens

**Use the built-in Oxy navigation patterns** with bottom sheets and modals:

```typescript
// Navigation should use the OxyRouter patterns
navigate('AccountCenter'); // Built-in account management
navigate('KarmaCenter');   // Built-in karma display
navigate('SignIn');        // Built-in authentication

// Always provide proper TypeScript navigation props
interface ScreenProps extends BaseScreenProps {
  theme: 'light' | 'dark';
  navigate?: (screen: string, params?: any) => void;
  goBack?: () => void;
  onClose?: () => void;
}
```

## File Management

**Use the Oxy file management system** for uploads and file handling:

```typescript
// Upload files through Oxy services
const uploadResponse = await oxyServices.uploadFile(file, {
  folder: "user_content",
  isPublic: true
});

// List user files
const { files } = await oxyServices.listUserFiles(userId);
```

## Error Handling

**Always handle Oxy API errors properly**:

```typescript
try {
  const result = await oxyServices.someOperation();
} catch (error) {
  // Oxy services return structured ApiError objects
  console.error('Oxy API Error:', error.message);
  console.error('Error Code:', error.code);
  console.error('Status:', error.status);
}
```

## Development Environment

**We use the Oxy cloud environment** at `https://cloud.oxy.so` by default. For local development, you may need to point to a local Oxy instance.

**Testing**: Always test authentication flows, karma earning, and wallet transactions in your Oxy integrations.

## Project Structure

**Follow the Oxy services project structure** when building apps:

```
src/
  screens/          # App-specific screens
  components/       # Custom components (use Oxy components first)
  services/         # Oxy service integrations
  types/           # TypeScript interfaces
  utils/           # Helper functions
```

## Best Practices

1. **Always check user authentication status** before allowing access to protected features
2. **Display karma prominently** in user profiles and interfaces
3. **Use Oxy wallet for all transactions** - don't implement separate payment systems
4. **Follow Oxy theming conventions** with support for light/dark modes
5. **Integrate with the existing Oxy user base** - don't create isolated user systems
6. **Use proper TypeScript types** from the Oxy services package
7. **Handle errors gracefully** with proper user feedback
8. **Implement responsive design** that works across web, iOS, and Android

## Common Integration Patterns

```typescript
// Complete app setup with Oxy
import { OxyProvider, useOxy } from '@oxyhq/services';

function App() {
  return (
    <OxyProvider
      config={{ baseURL: "https://cloud.oxy.so" }}
      onAuthStateChange={(user) => console.log('Auth changed:', user)}
    >
      <YourAppContent />
    </OxyProvider>
  );
}

function YourAppContent() {
  const { user, oxyServices, isAuthenticated } = useOxy();
  
  if (!isAuthenticated) {
    return <SignInPrompt />;
  }
  
  return <AuthenticatedApp user={user} services={oxyServices} />;
}
```

Remember: You're building on top of the Oxy ecosystem, not creating a standalone app. Always integrate with existing Oxy users, karma, wallets, and services rather than building parallel systems.
