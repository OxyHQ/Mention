# Mention

> A modern, cross-platform social app built with Expo, React Native, and TypeScript.

---

## Table of Contents
- [About](#about)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Development Scripts](#development-scripts)
- [Contributing](#contributing)
- [License](#license)

---

## About

**Mention** is a universal social platform inspired by Twitter/X, designed for mobile and web. It features real-time feeds, user profiles, trends, notifications, and more. Built with Expo and React Native, it supports file-based routing, multi-language support, and a modern UI.

## Features
- Universal app: Android, iOS, and Web
- Real-time feed with posts, replies, quotes, and reposts
- User profiles with followers/following
- Trends and analytics
- Bookmarks, lists, and media posts
- Notifications (push and in-app)
- Multi-language support (English, Spanish, Italian)
- Responsive design and theming
- Modern UI with custom icons and animations

## Tech Stack
- [Expo](https://expo.dev/) & React Native
- TypeScript
- NativeWind (Tailwind CSS for React Native)
- Redux Toolkit & React Query
- i18next (internationalization)
- Expo Router (file-based routing)
- Custom SVG icons
- Expo Notifications, Secure Store, Camera, Video, Image Picker

## Project Structure
```
├── app/                # App entry, screens, and routing
│   ├── [username]/     # User profile, followers, following
│   ├── kaana/          # AI assistant or help section
│   ├── p/[id]/         # Post details, replies, quotes
│   └── ...
├── components/         # UI components (Feed, Post, SideBar, etc.)
├── assets/             # Images, icons, fonts
├── constants/          # App-wide constants
├── context/            # React context providers
├── features/           # Feature modules (e.g., trends)
├── hooks/              # Custom React hooks
├── interfaces/         # TypeScript interfaces
├── lib/                # Library code (e.g., reactQuery)
├── locales/            # i18n translation files
├── scripts/            # Utility scripts
├── store/              # Redux store and reducers
├── styles/             # Global styles and colors
├── utils/              # Utility functions
├── app.config.js       # Expo app configuration
├── package.json        # Project metadata and dependencies
└── ...
```

## Getting Started

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Start the app**
   ```bash
   npx expo start
   ```

3. **Open in your preferred environment:**
   - Expo Go (mobile)
   - Android/iOS emulator
   - Web browser

4. **Edit code:**
   - Main screens: `app/`
   - Components: `components/`

## Development Scripts

- `npm start` — Start Expo development server
- `npm run android` — Run on Android device/emulator
- `npm run ios` — Run on iOS simulator
- `npm run web` — Run in web browser
- `npm run build-web` — Build static web output
- `npm run reset-project` — Reset to a fresh project state
- `npm run lint` — Lint codebase

## Contributing

Contributions are welcome! Please open issues or pull requests for bug fixes, features, or improvements.

## License

This project is licensed under the MIT License.
