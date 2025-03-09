/**
 * Auth Events
 * 
 * A simple event emitter for authentication-related events.
 * This allows components to trigger auth flows from anywhere in the app.
 */

import { AuthMode } from '../components/AuthBottomSheet/types';

type EventCallback = (mode?: AuthMode) => void;

interface EventMap {
  [key: string]: EventCallback[];
}

class AuthEvents {
  private events: EventMap = {};

  /**
   * Subscribe to an event
   * @param event Event name
   * @param callback Callback function
   */
  on(event: string, callback: EventCallback): void {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    this.events[event].push(callback);
  }

  /**
   * Unsubscribe from an event
   * @param event Event name
   * @param callback Optional callback function to remove
   */
  off(event: string, callback?: EventCallback): void {
    if (!this.events[event]) return;

    if (callback) {
      this.events[event] = this.events[event].filter(cb => cb !== callback);
    } else {
      delete this.events[event];
    }
  }

  /**
   * Emit an event
   * @param event Event name
   * @param mode Optional auth mode
   */
  emit(event: string, mode?: AuthMode): void {
    if (!this.events[event]) return;

    this.events[event].forEach(callback => {
      callback(mode);
    });
  }

  /**
   * Trigger authentication required
   * @param mode Auth mode (default: 'signin')
   */
  requireAuth(mode: AuthMode = 'signin'): void {
    this.emit('authRequired', mode);
  }

  /**
   * Trigger signup required
   */
  requireSignup(): void {
    this.emit('signupRequired', 'signup');
  }

  /**
   * Trigger session selection required
   */
  requireSession(): void {
    this.emit('sessionRequired', 'session');
  }
}

// Export a singleton instance
export const authEvents = new AuthEvents(); 