"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.API_URL_SOCKET = exports.SOCKET_URL = exports.API_URL = void 0;
// Base URLs
exports.API_URL = process.env.API_URL || 'http://localhost:3000/';
exports.SOCKET_URL = process.env.API_URL_SOCKET || 'http://localhost:3000/';
exports.API_URL_SOCKET = process.env.API_URL_SOCKET || "ws://localhost:3000";
