// HTTP-клиент для JWT-авторизации (тот же бекенд, что и в прошлом задании).
// access-токен хранится только в памяти (не в localStorage), поэтому XSS не
// может украсть долгоживущую сессию. refresh-токен лежит в HttpOnly cookie:
// его ставит и читает сервер, из JS он недоступен.

export const API_BASE = 'https://inai-col3.fishrungames.com/api';

export interface User {
  id?: number;
  username: string;
  [key: string]: unknown;
}

export type FieldErrors = Record<string, string>;

type Json = unknown;

export class ApiError extends Error {
  readonly status: number;
  readonly data: Json;
  readonly fieldErrors: FieldErrors;

  constructor(status: number, data: Json) {
    super(extractMessage(status, data));
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.fieldErrors = extractFieldErrors(data);
  }
}

export const isAuthRejected = (err: unknown): boolean => {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractMessage(status: number, data: Json): string {
  if (status === 0) return 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.';
  if (isRecord(data)) {
    if (typeof data.detail === 'string') return data.detail;
    if (Array.isArray(data.non_field_errors)) return data.non_field_errors.join(' ');
    if (Object.keys(extractFieldErrors(data)).length) return 'Проверьте поля формы.';
  }
  if (status >= 500) return 'Ошибка сервера. Попробуйте позже.';
  return `Запрос не выполнен (код ${status}).`;
}

// DRF отдаёт ошибки полей в виде { field: ["msg", ...] }.
function extractFieldErrors(data: Json): FieldErrors {
  const result: FieldErrors = {};
  if (!isRecord(data)) return result;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'detail' || key === 'non_field_errors') continue;
    if (Array.isArray(value)) result[key] = value.join(' ');
    else if (typeof value === 'string') result[key] = value;
    else if (isRecord(value)) Object.assign(result, extractFieldErrors(value));
  }
  return result;
}

async function parseBody(res: Response): Promise<Json> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as Json;
  } catch {
    // Не JSON (например, HTML-страница ошибки nginx). Пользователю её не
    // показываем, текст ошибки берётся из HTTP-статуса.
    return null;
  }
}

function readAccess(data: Json): string | null {
  return isRecord(data) && typeof data.access === 'string' ? data.access : null;
}

function isUser(data: Json): data is User {
  return isRecord(data) && typeof data.username === 'string';
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface SendOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  withAuth?: boolean;
}

export interface ApiOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  onSessionExpired?: () => void;
}

export interface Api {
  register(username: string, password: string): Promise<User>;
  login(username: string, password: string): Promise<User>;
  restoreSession(): Promise<User | null>;
  getProfile(): Promise<User>;
  getAccessToken(options?: { fresh?: boolean }): Promise<string>;
  logout(): Promise<void>;
  isAuthenticated(): boolean;
}

export function createApi({
  baseUrl = API_BASE,
  fetchImpl = (input, init) => globalThis.fetch(input, init),
  onSessionExpired = () => {},
}: ApiOptions = {}): Api {
  let accessToken: string | null = null;
  let refreshPromise: Promise<string> | null = null;

  async function send(path: string, { method = 'GET', body, withAuth = false }: SendOptions = {}) {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (withAuth && accessToken) headers.Authorization = `Bearer ${accessToken}`;

    const init: RequestInit = {
      method,
      headers,
      // Без этого браузер не сохранит и не отправит cookie с refresh-токеном.
      credentials: 'include',
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res: Response;
    try {
      res = await fetchImpl(baseUrl + path, init);
    } catch {
      throw new ApiError(0, null);
    }
    return { res, data: await parseBody(res) };
  }

  // Если обновить токен просят сразу несколько мест (HTTP-запрос и
  // переподключение сокета), refresh всё равно выполняется один раз.
  function refresh(): Promise<string> {
    refreshPromise ??= (async () => {
      const { res, data } = await send('/token/refresh/', { method: 'POST' });
      const access = readAccess(data);
      if (!res.ok || access === null) {
        if (isAuthRejected(res)) accessToken = null;
        throw new ApiError(res.status, data);
      }
      accessToken = access;
      return access;
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  async function refreshOrExpire(): Promise<string> {
    try {
      return await refresh();
    } catch (err) {
      if (isAuthRejected(err)) onSessionExpired();
      throw err;
    }
  }

  // Запрос с access-токеном: при 401 один раз обновляем токен и повторяем.
  async function authed(path: string, options: SendOptions = {}): Promise<Json> {
    if (!accessToken) await refreshOrExpire();

    let { res, data } = await send(path, { ...options, withAuth: true });
    if (res.status === 401) {
      await refreshOrExpire();
      ({ res, data } = await send(path, { ...options, withAuth: true }));
      if (res.status === 401) {
        accessToken = null;
        onSessionExpired();
      }
    }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  async function getProfile(): Promise<User> {
    const data = await authed('/profile/');
    if (!isUser(data)) throw new ApiError(200, data);
    return data;
  }

  async function authenticate(path: string, username: string, password: string): Promise<User> {
    const { res, data } = await send(path, { method: 'POST', body: { username, password } });
    const access = readAccess(data);
    if (!res.ok || access === null) throw new ApiError(res.status, data);
    accessToken = access;
    const user = isRecord(data) ? data.user : undefined;
    return isUser(user) ? user : getProfile();
  }

  return {
    register: (username, password) => authenticate('/register/', username, password),
    login: (username, password) => authenticate('/login/', username, password),

    // При загрузке страницы: если cookie с refresh-токеном ещё действует,
    // восстанавливаем сессию без повторного ввода пароля.
    async restoreSession() {
      try {
        await refresh();
      } catch (err) {
        if (isAuthRejected(err)) return null;
        throw err;
      }
      return getProfile();
    },

    getProfile,

    // Токен для первого сообщения AUTH в WebSocket. fresh = true нужен при
    // переподключении: старый access мог истечь, и сервер отключит сокет.
    // При отклонённом refresh вызывается onSessionExpired.
    async getAccessToken({ fresh = false } = {}) {
      if (!fresh && accessToken) return accessToken;
      return refreshOrExpire();
    },

    // Локальный выход выполняется всегда, даже если сервер недоступен.
    async logout() {
      try {
        await send('/logout/', { method: 'POST', withAuth: true });
      } catch {
        // Сеть недоступна: cookie доживёт до истечения срока, но в этой
        // вкладке access-токен всё равно удаляется.
      } finally {
        accessToken = null;
      }
    },

    isAuthenticated: () => accessToken !== null,
  };
}
