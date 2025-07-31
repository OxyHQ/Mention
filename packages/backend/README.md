# @mention/backend

> The backend package of the Mention monorepo - A robust API service built with Express.js and TypeScript.

---

## Overview

This is the **backend package** of the **Mention** monorepo. The Mention API is a robust backend service built with Express.js and TypeScript, providing functionality for social media interactions including posts, user management, authentication, and real-time communications.

## Tech Stack

- Node.js with TypeScript
- Express.js for REST API
- MongoDB with Mongoose for data storage
- Socket.IO for real-time features
- JWT for authentication

## Getting Started

### Prerequisites

- Node.js 18+ and npm 8+
- MongoDB instance
- Git

### Development Setup

#### Option 1: From the Monorepo Root (Recommended)
```bash
# Clone the repository
git clone https://github.com/OxyHQ/Mention.git
cd Mention

# Install all dependencies
npm run install:all

# Start backend development
npm run dev:backend
```

#### Option 2: From This Package Directory
```bash
# Navigate to this package
cd packages/backend

# Install dependencies
npm install

# Start development server
npm run dev
```

### Environment Configuration

Create a `.env` file in this package directory with the following variables:

```env
# Database
MONGODB_URI=your_mongodb_connection_string

# Authentication
# WE USE OXY FOR AUTHENTICATION

# Server Configuration
PORT=3000
NODE_ENV=development

# External Services
OPENAI_API_KEY=your_openai_api_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
```

### Running the API

#### Development Mode
```bash
npm run dev
```

#### Production Mode
```bash
npm run build
npm start
```

### Database Setup

The API uses MongoDB with Mongoose. Make sure your MongoDB instance is running and accessible.

#### Running Migrations
```bash
# Development environment
npm run migrate:dev

# Production environment
npm run migrate
```

## API Endpoints

### Authentication Flow

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant Database
    
    Client->>API: POST /auth/signup
    API->>Database: Create User
    Database-->>API: User Created
    API-->>Client: Access Token
    
    Client->>API: POST /auth/login
    API->>Database: Verify Credentials
    Database-->>API: User Found
    API-->>Client: Access + Refresh Tokens
```

### Authentication

#### POST /auth/signup
- Creates a new user account
- Body: `{ username: string, email: string, password: string }`
- Returns:
```json
{
  "user": {
    "id": "user_id",
    "username": "john_doe",
    "email": "john@example.com",
    "createdAt": "2023-01-01T00:00:00Z"
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

#### POST /auth/login
- Authenticates existing user
- Body: `{ email: string, password: string }`
- Returns:
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

### Posts

#### POST /posts
- Creates a new post
- Authentication: Bearer token required
- Body:
```json
{
  "text": "Hello world!",
  "media": ["image1.jpg"],
  "location": {
    "longitude": -73.935242,
    "latitude": 40.730610
  }
}
```
- Returns:
```json
{
  "id": "post_id",
  "text": "Hello world!",
  "media": ["image1.jpg"],
  "location": {
    "type": "Point",
    "coordinates": [-73.935242, 40.730610]
  },
  "createdAt": "2023-01-01T00:00:00Z",
  "user": {
    "id": "user_id",
    "username": "john_doe"
  }
}
```

#### GET /posts/explore
- Retrieves posts for exploration
- Query params: `limit` (default: 20), `offset` (default: 0)
- Returns:
```json
{
  "posts": [
    {
      "id": "post_id",
      "text": "Post content",
      "user": {
        "id": "user_id",
        "username": "john_doe"
      },
      "createdAt": "2023-01-01T00:00:00Z"
    }
  ],
  "total": 100,
  "hasMore": true
}
```

### Users

#### GET /users/:username
- Retrieves user profile
- Authentication: Bearer token required
- Returns:
```json
{
  "id": "user_id",
  "username": "john_doe",
  "bio": "Hello, I'm John!",
  "followersCount": 1000,
  "followingCount": 500,
  "postsCount": 100,
  "isFollowing": true
}
```

## Database Schema Relationships

```mermaid
erDiagram
    User ||--o{ Post : creates
    User ||--o{ Bookmark : has
    User ||--o{ Follow : follows
    Post ||--o{ Like : receives
    Post ||--o{ Comment : has
    
    User {
        string id PK
        string username
        string email
        string password
        string[] bookmarks
        datetime createdAt
    }
    
    Post {
        string id PK
        string userId FK
        string text
        string[] media
        object location
        datetime createdAt
    }
```

## Development Scripts

- `npm run dev` — Start development server with hot reload
- `npm run build` — Build the project
- `npm run start` — Start production server
- `npm run lint` — Lint codebase
- `npm run clean` — Clean build artifacts
- `npm run migrate` — Run database migrations
- `npm run migrate:dev` — Run database migrations in development
- `npm run test` — Run tests (placeholder)

## Monorepo Integration

This package is part of the Mention monorepo and integrates with:

- **@mention/frontend**: React Native application
- **@mention/shared-types**: Shared TypeScript type definitions

### Shared Dependencies
- Uses `@homiio/shared-types` for type safety across packages
- Integrates with `@oxyhq/services` for common functionality

## Performance Optimization

### Caching Strategy
- Implement Redis caching for:
  - User profiles (TTL: 1 hour)
  - Popular posts (TTL: 15 minutes)
  - Trending hashtags (TTL: 5 minutes)

### Database Indexing
```javascript
// User Collection Indexes
db.users.createIndex({ "username": 1 }, { unique: true })
db.users.createIndex({ "email": 1 }, { unique: true })

// Post Collection Indexes
db.posts.createIndex({ "userId": 1, "createdAt": -1 })
db.posts.createIndex({ "location": "2dsphere" })
```

## Monitoring and Logging

### Health Check Endpoint
```
GET /health
Response: {
  "status": "healthy",
  "version": "1.0.0",
  "uptime": 1000,
  "mongoStatus": "connected"
}
```

### Logging
- Use Winston for structured logging
- Log levels: error, warn, info, debug
- Include request ID in all logs

## Deployment

### Docker Deployment
```bash
# Build the Docker image
docker build -t mention-api .

# Run the container
docker run -p 3000:3000 -e MONGODB_URI=your_mongodb_uri mention-api
```

### Cloud Deployment (Vercel)
1. Configure `vercel.json`:
```json
{
  "version": 2,
  "builds": [{
    "src": "dist/server.js",
    "use": "@vercel/node"
  }],
  "routes": [{
    "src": "/(.*)",
    "dest": "dist/server.js"
  }]
}
```

2. Deploy using Vercel CLI:
```bash
vercel --prod
```

## Troubleshooting Guide

### Common Issues

1. Connection Timeouts
```
Error: MongoTimeoutError
Solution: Check MongoDB connection string and network connectivity
```

2. Authentication Failures
```
Error: JsonWebTokenError
Solution: Verify token expiration and secret keys
```

3. Rate Limit Exceeded
```
Error: 429 Too Many Requests
Solution: Implement exponential backoff in client
```

## Contributing

Contributions are welcome! Please see the [main README](../../README.md) for the complete contributing guidelines.

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and linting: `npm run test && npm run lint`
5. Submit a pull request

## License

This project is licensed under the AGPL License.
