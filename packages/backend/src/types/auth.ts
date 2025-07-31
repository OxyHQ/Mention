import { Request } from 'express';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    [key: string]: any;
  };
} 