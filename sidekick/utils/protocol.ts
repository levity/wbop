/**
 * Sidekick Protocol
 *
 * Minimal: send JS code, get result back.
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

export type Request = EvalRequest | TabsRequest | ScreenshotRequest;

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

export type Response = EvalResponse | TabsResponse | ScreenshotResponse;

// Relay -> Extension message (forwarded from CLI)
export interface RelayMessage {
  id: string;
  request: Request;
}

// Extension -> Relay message (response to CLI)
export interface RelayResponse {
  id: string;
  response: Response;
}
