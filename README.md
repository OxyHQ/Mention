# Mention

> A modern, cross-platform social app built with Expo, React Native, TypeScript, and a Node.js/Express backend.

---

## Table of Contents
- [About](#about)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Development Scripts](#development-scripts)
- [API Documentation](#api-documentation)
- [Contributing](#contributing)
- [License](#license)

---

## About

**Mention** is a universal social platform inspired by Twitter/X, designed for mobile and web. It features real-time feeds, user profiles, trends, notifications, and more. Built with Expo, React Native, and a Node.js backend, it supports file-based routing, multi-language support, and a modern UI.

## Project Structure

```
/
├── packages/            # All code packages
│   ├── backend/         # Backend code
│   │   ├── src/         # Backend source code
│   │   │   ├── controllers/ # API controllers
│   │   │   ├── middleware/  # Express middleware
│   │   │   ├── models/      # MongoDB models
│   │   │   ├── routes/      # API routes
│   │   │   ├── scripts/     # Utility scripts
│   │   │   ├── sockets/     # WebSocket handlers
│   │   │   ├── types/       # TypeScript types
│   │   │   └── utils/       # Utility functions
│   │   └── ...
│   └── frontend/        # Frontend code
│       ├── app/         # App entry, screens, and routing
│       │   ├── [username]/  # User profile, followers, following
│       │   ├── kaana/       # AI assistant or help section
│       │   ├── p/[id]/      # Post details, replies, quotes
│       │   └── ...
│       ├── components/  # UI components
│       ├── assets/      # Images, icons, fonts
│       ├── constants/   # App-wide constants
│       ├── context/     # React context providers
│       ├── features/    # Feature modules
│       ├── hooks/       # Custom React hooks
│       ├── interfaces/  # TypeScript interfaces
│       ├── lib/         # Library code
│       ├── locales/     # i18n translation files
│       ├── scripts/     # Utility scripts
│       ├── store/       # Redux store and reducers
│       ├── styles/      # Global styles and colors
│       └── utils/       # Utility functions
```

## Getting Started

### Prerequisites
- Node.js 14+ and npm/yarn
- MongoDB instance
- Expo CLI for mobile development

### Frontend Setup
1. **Navigate to the frontend directory**
   ```bash
   cd packages/frontend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the app**
   ```bash
   npx expo start
   ```

### Backend Setup
1. **Navigate to the backend directory**
   ```bash
   cd packages/backend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the server**
   ```bash
   npm run dev
   ```

## Development Scripts

### Frontend
- `npm start` — Start Expo development server
- `npm run android` — Run on Android device/emulator
- `npm run ios` — Run on iOS simulator
- `npm run web` — Run in web browser
- `npm run build-web` — Build static web output
- `npm run lint` — Lint codebase

### Backend
- `npm run dev` — Start the development server with hot reload
- `npm run build` — Build the project
- `npm run start` — Start the production server
- `npm run lint` — Lint codebase

## API Documentation

The Mention API is a robust backend service built with Express.js and TypeScript, providing functionality for social media interactions including posts, user management, authentication, and real-time communications.

For detailed API information, see the [Backend README](packages/backend/README.md).

## Contributing

Contributions are welcome! Please open issues or pull requests for bug fixes, features, or improvements.

## License

This project is licensed under the MIT License.