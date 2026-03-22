/**
 * MTN Protocol Lexicon Type System
 *
 * Meta-schema types that define the shape of lexicon definitions.
 * Inspired by AT Protocol's Lexicon v1.
 */

export type LexiconFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'datetime'
  | 'uri'
  | 'mtn-uri'
  | 'bytes'
  | 'cid'
  | 'object'
  | 'array'
  | 'ref'
  | 'union'
  | 'unknown';

export interface LexiconField {
  type: LexiconFieldType;
  description?: string;
  optional?: boolean;
  // String constraints
  maxLength?: number;
  minLength?: number;
  format?: string;
  enum?: readonly string[];
  // Number constraints
  minimum?: number;
  maximum?: number;
  // Array constraints
  items?: LexiconField;
  maxItems?: number;
  minItems?: number;
  // Object constraints
  properties?: Record<string, LexiconField>;
  required?: readonly string[];
  // Ref/Union
  ref?: string;
  refs?: readonly string[];
}

export interface LexiconDef {
  type: 'record' | 'object' | 'token' | 'procedure' | 'query' | 'subscription';
  description?: string;
  key?: string;
  record?: {
    type: 'object';
    required?: readonly string[];
    properties: Record<string, LexiconField>;
  };
  properties?: Record<string, LexiconField>;
  required?: readonly string[];
}

export interface LexiconDoc {
  lexicon: 1;
  id: string;
  description: string;
  defs: Record<string, LexiconDef>;
}
