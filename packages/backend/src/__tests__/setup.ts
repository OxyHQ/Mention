// Jest setup for profile tests
import 'jest-extended';

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.ACCESS_TOKEN_SECRET = 'test-secret';

// Suppress mongoose deprecation warnings in tests
process.env.MONGOOSE_DISABLE_STABILITY_WARNING = '1';