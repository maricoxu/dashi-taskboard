export function postEmbeddedHostMessage(message: Record<string, unknown>): void;
export function isEmbeddedHost(): boolean;
export function requestEmbeddedHostHttp(input: Record<string, unknown>): Promise<{
  requestId: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyBase64: string;
}> | null;
export function fetchEmbeddedHost(url: string | URL, init?: RequestInit): Promise<Response | null>;
export function installEmbeddedExternalLinkHandler(): () => void;
export function setEmbeddedFrameChallenge(challenge: string): void;
