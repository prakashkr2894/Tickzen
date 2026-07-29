/**
 * HTTP client for the Express API.
 *
 * Browser (default): uses relative `/api/...` → Next.js rewrites to Express
 * (see `next.config.mjs` BACKEND_URL, default http://localhost:5000).
 *
 * Direct to Express: set NEXT_PUBLIC_API_BASE_URL=http://localhost:5000/api
 * (no proxy; CORS must allow your Next origin).
 */

const TOKEN_KEY = "token";
const SESSION_KEY = "auth-session";
let memoryToken: string | null = null;

/** SSR / Node fallback when env is not set — same port as backend default */
const SERVER_FALLBACK_API = "http://localhost:5000/api";

function getApiBaseUrl(): string {
  const fromEnv = (process.env.NEXT_PUBLIC_API_BASE_URL || process.env.NEXT_PUBLIC_API_URL)?.trim();
  if (fromEnv) {
    return fromEnv.replace(/\/+$/, "");
  }
  if (typeof window !== "undefined") {
    return "/api";
  }
  return SERVER_FALLBACK_API;
}


export { getApiBaseUrl };

function toWebSocketBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed;
  }

  if (trimmed.startsWith("http://")) {
    return trimmed.replace(/^http:\/\//, "ws://").replace(/\/api$/, "");
  }

  if (trimmed.startsWith("https://")) {
    return trimmed.replace(/^https:\/\//, "wss://").replace(/\/api$/, "");
  }

  return trimmed;
}

export function getWebSocketBaseUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_WS_BASE_URL?.trim();
  if (fromEnv) {
    return toWebSocketBaseUrl(fromEnv);
  }

  const apiBase = getApiBaseUrl();
  if (apiBase === "/api") {
    if (typeof window !== "undefined") {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      return `${protocol}//${window.location.host}`;
    }
    return "ws://localhost:5000";
  }

  return toWebSocketBaseUrl(apiBase);
}

function toSocketIoBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.replace(/\/api$/, "");
  }

  if (trimmed.startsWith("ws://")) {
    return trimmed.replace(/^ws:\/\//, "http://").replace(/\/api$/, "");
  }

  if (trimmed.startsWith("wss://")) {
    return trimmed.replace(/^wss:\/\//, "https://").replace(/\/api$/, "");
  }

  return trimmed;
}

export function getSocketIoBaseUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_SOCKET_IO_URL?.trim();
  if (fromEnv) {
    return toSocketIoBaseUrl(fromEnv);
  }

  const apiBase = getApiBaseUrl();
  if (apiBase === "/api") {
    if (typeof window !== "undefined") {
      return window.location.origin;
    }
    return "http://localhost:5000";
  }

  return toSocketIoBaseUrl(apiBase);
}


export function getToken(): string | null {
  if (typeof window === "undefined") return null;

  if (memoryToken) return memoryToken;

  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    memoryToken = token;
    return token;
  }

  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;

    const session = JSON.parse(raw) as { token?: string };
    return session.token || null;
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  if (typeof window === "undefined") return;
  memoryToken = token;
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  if (typeof window === "undefined") return;
  memoryToken = null;
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  data?: unknown;

  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

export type ApiRequestOptions = Omit<RequestInit, "headers"> & {
  auth?: boolean;
  headers?: HeadersInit;
};

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { auth = true, headers: customHeaders, ...init } = options;
  const token = getToken();
  const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;

  const base = getApiBaseUrl();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${base}${normalizedPath}`;

  const headers = new Headers(customHeaders);
  if (!isFormData && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (auth && token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(url, {
    ...init,
    headers,
  });

  const data: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    const isTrialExpired =
      typeof data === "object" &&
      data !== null &&
      "trialExpired" in data &&
      (data as { trialExpired: unknown }).trialExpired === true;

    if (isTrialExpired || response.status === 401 || (response.status === 403 && isTrialExpired)) {
      clearToken();
      if (typeof window !== "undefined") {
        localStorage.removeItem("user");
        localStorage.removeItem("auth-session");
        if (window.location.pathname !== "/") {
          window.location.href = `/?trialExpired=true`;
        }
      }
    }

    const message =
      typeof data === "object" &&
      data !== null &&
      "message" in data &&
        typeof (data as { message: unknown }).message === "string"
        ? (data as { message: string }).message
        : "Request failed";
    throw new ApiError(message, response.status, data);
  }

  return data as T;
}
