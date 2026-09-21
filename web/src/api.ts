const TOKEN_KEY = 'swarm.feedback.token';

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  details: unknown;
  constructor(status: number, message: string, details: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) as { error?: { message?: string; details?: unknown } } : null;
  if (response.status === 401 && !path.endsWith('/auth/login')) {
    setToken(null);
    window.dispatchEvent(new Event('swarm-auth-expired'));
  }
  if (!response.ok) {
    throw new ApiError(response.status, data?.error?.message ?? response.statusText, data?.error?.details ?? null);
  }
  return data as T;
}
