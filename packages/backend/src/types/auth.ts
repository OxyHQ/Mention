import { Request } from "express";

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email?: string;
    username?: string;
    [key: string]: any;
  };
}
