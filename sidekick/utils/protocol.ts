/**
 * Sidekick Protocol
 */

export interface EvalRequest {
  type: 'eval';
  tabId?: number;
  code: string;
}

export interface TabsRequest {
  type: 'tabs';
}

export interface ScreenshotRequest {
  type: 'screenshot';
  tabId?: number;
}

export interface ScratchpadWriteRequest {
  type: 'scratchpadWrite';
  from: 'browser' | 'agent';
  body: string;
}

export interface ScratchpadReadRequest {
  type: 'scratchpadRead';
  from?: 'browser' | 'agent';
  afterId?: string;
}

export type Request = EvalRequest | TabsRequest | ScreenshotRequest | ScratchpadWriteRequest | ScratchpadReadRequest;

export interface ScratchpadEntry {
  id: string;
  from: 'browser' | 'agent';
  body: string;
  ts: string;
}

export interface EvalResponse {
  type: 'eval';
  success: boolean;
  result?: any;
  error?: string;
}

export interface TabsResponse {
  type: 'tabs';
  success: boolean;
  tabs?: Array<{ id: number; title: string; url: string }>;
  error?: string;
}

export interface ScreenshotResponse {
  type: 'screenshot';
  success: boolean;
  image?: string; // base64
  error?: string;
}

export interface ScratchpadWriteResponse {
  type: 'scratchpadWrite';
  success: boolean;
  entry?: ScratchpadEntry;
  error?: string;
}

export interface ScratchpadReadResponse {
  type: 'scratchpadRead';
  success: boolean;
  found?: boolean;
  entry?: ScratchpadEntry;
  error?: string;
}

export type Response = EvalResponse | TabsResponse | ScreenshotResponse | ScratchpadWriteResponse | ScratchpadReadResponse;

export interface RelayMessage {
  id: string;
  request: Request;
}

export interface RelayResponse {
  id: string;
  response: Response;
}
