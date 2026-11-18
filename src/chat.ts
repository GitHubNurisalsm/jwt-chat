// WebSocket-клиент группового чата.
//
// Протокол:
//   клиент → {type: "AUTH", payload: {token}}            первое сообщение после open
//   сервер → {type: "AUTH_SUCCESS", payload: {username}} токен принят
//   клиент → {type: "CHAT_MESSAGE", payload: {text}}
//   сервер → {type: "NEW_MESSAGE", payload: {sender, text, timestamp}}
// При неверном токене или неверном сообщении сервер закрывает соединение.

export const CHAT_URL = 'wss://inai-col3.fishrungames.com/chat/';
export const MAX_MESSAGE_LENGTH = 1000;

const WS_OPEN = 1;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;

// ---------- Типы протокола ----------

export type ClientFrame =
  | { type: 'AUTH'; payload: { token: string } }
  | { type: 'CHAT_MESSAGE'; payload: { text: string } };

export interface ChatMessage {
  sender: string;
  text: string;
  /** Unix-время в миллисекундах. */
  timestamp: number;
}

/**
 * connecting   — первое подключение;
 * reconnecting — соединение потеряно, ждём следующую попытку;
 * online       — получен AUTH_SUCCESS, можно писать;
 * offline      — клиент остановлен (logout, истёкшая сессия, сервер не принимает токен).
 */
export type ChatStatus = 'connecting' | 'reconnecting' | 'online' | 'offline';

/**
 * session — refresh отклонён, нужен повторный вход;
 * auth    — сокет открывается, но сервер раз за разом рвёт его до AUTH_SUCCESS.
 */
export type FatalReason = 'session' | 'auth';

/** Минимум WebSocket API, который нужен клиенту (подменяется в тестах). */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = new (url: string) => SocketLike;

// В браузере setTimeout возвращает number, в Node — объект Timeout.
export type TimerId = ReturnType<typeof setTimeout> | number;

export interface ChatClientOptions {
  url?: string;
  getToken: (options: { fresh: boolean }) => Promise<string>;
  WebSocketImpl?: SocketFactory;
  setTimer?: (fn: () => void, ms: number) => TimerId;
  clearTimer?: (id: TimerId) => void;
  onStatus?: (status: ChatStatus) => void;
  onReady?: (username: string | null) => void;
  onMessage?: (message: ChatMessage) => void;
  onFatal?: (reason: FatalReason) => void;
  authTimeoutMs?: number;
  maxAuthFailures?: number;
}

export interface ChatClient {
  start(): void;
  stop(): void;
  /** true, если сообщение ушло в сокет. */
  send(text: string): boolean;
  isReady(): boolean;
  getStatus(): ChatStatus;
}

// ---------- Чистые функции ----------

export type MessageError = 'empty' | 'too_long';

export function validateMessage(text: string): { error: MessageError | null; value: string } {
  const value = text.trim();
  if (!value) return { error: 'empty', value };
  if (value.length > MAX_MESSAGE_LENGTH) return { error: 'too_long', value };
  return { error: null, value };
}

export function retryDelay(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
}

type ServerFrame = { type: string; payload?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseFrame(data: unknown): ServerFrame | null {
  if (typeof data !== 'string') return null;
  try {
    const frame: unknown = JSON.parse(data);
    if (!isRecord(frame) || typeof frame.type !== 'string') return null;
    return { type: frame.type, payload: frame.payload };
  } catch {
    return null;
  }
}

function parseChatMessage(payload: unknown): ChatMessage | null {
  if (!isRecord(payload) || typeof payload.sender !== 'string' || typeof payload.text !== 'string') {
    return null;
  }
  const { timestamp } = payload;
  return {
    sender: payload.sender,
    text: payload.text,
    timestamp: typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now(),
  };
}

function encode(frame: ClientFrame): string {
  return JSON.stringify(frame);
}

// ---------- Клиент ----------

export function createChatClient({
  url = CHAT_URL,
  getToken,
  WebSocketImpl = globalThis.WebSocket as unknown as SocketFactory,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  onStatus = () => {},
  onReady = () => {},
  onMessage = () => {},
  onFatal = () => {},
  authTimeoutMs = 10000,
  maxAuthFailures = 3,
}: ChatClientOptions): ChatClient {
  let socket: SocketLike | null = null;
  // Каждое подключение получает свой номер. События от старых сокетов и
  // запоздавшие ответы getToken сравнивают номер и игнорируются.
  let generation = 0;
  let stopped = true;
  let ready = false;
  let attempt = 0;
  let authFailures = 0;
  let retryTimer: TimerId | null = null;
  let authTimer: TimerId | null = null;
  let status: ChatStatus = 'offline';

  function setStatus(next: ChatStatus): void {
    if (status === next) return;
    status = next;
    onStatus(next);
  }

  function clearAuthTimer(): void {
    if (authTimer !== null) clearTimer(authTimer);
    authTimer = null;
  }

  function clearTimers(): void {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
    clearAuthTimer();
  }

  function fail(reason: FatalReason): void {
    stop();
    onFatal(reason);
  }

  function scheduleRetry(): void {
    attempt += 1;
    setStatus('reconnecting');
    retryTimer = setTimer(() => {
      retryTimer = null;
      void connect(true);
    }, retryDelay(attempt));
  }

  async function connect(freshToken: boolean): Promise<void> {
    const gen = ++generation;
    const isStale = () => stopped || gen !== generation;
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting');

    let token: string;
    try {
      token = await getToken({ fresh: freshToken });
    } catch (err) {
      if (isStale()) return;
      const errStatus = isRecord(err) ? err.status : undefined;
      if (errStatus === 401 || errStatus === 403) return fail('session');
      return scheduleRetry(); // сеть или 5xx: попробуем позже
    }
    if (isStale()) return;

    let ws: SocketLike;
    try {
      ws = new WebSocketImpl(url);
    } catch {
      return scheduleRetry();
    }
    socket = ws;
    ready = false;
    let opened = false;

    ws.onopen = () => {
      if (isStale()) return;
      opened = true;
      ws.send(encode({ type: 'AUTH', payload: { token } }));
      // Если сервер не ответил ни AUTH_SUCCESS, ни закрытием, не висим вечно.
      authTimer = setTimer(() => {
        authTimer = null;
        ws.close();
      }, authTimeoutMs);
    };

    ws.onmessage = (event) => {
      if (isStale()) return;
      const frame = parseFrame(event.data);
      if (!frame) return;

      if (frame.type === 'AUTH_SUCCESS') {
        clearAuthTimer();
        ready = true;
        attempt = 0;
        authFailures = 0;
        setStatus('online');
        const username = isRecord(frame.payload) ? frame.payload.username : undefined;
        onReady(typeof username === 'string' ? username : null);
        return;
      }

      if (frame.type === 'NEW_MESSAGE' && ready) {
        const message = parseChatMessage(frame.payload);
        if (message) onMessage(message);
      }
      // Неизвестные типы игнорируем, чтобы новые события сервера не ломали клиент.
    };

    ws.onclose = () => {
      if (isStale()) return;
      clearAuthTimer();
      socket = null;
      const wasReady = ready;
      ready = false;

      // Открылся, но закрылся до AUTH_SUCCESS: скорее всего, сервер не принял
      // токен. Следующая попытка возьмёт свежий токен. Если и это не помогает,
      // останавливаемся, а не долбим сервер бесконечно.
      if (opened && !wasReady) {
        authFailures += 1;
        if (authFailures >= maxAuthFailures) return fail('auth');
      }
      scheduleRetry();
    };

    ws.onerror = () => {
      // После error всегда приходит close, переподключение запускается там.
    };
  }

  function start(): void {
    if (!stopped) return;
    stopped = false;
    attempt = 0;
    authFailures = 0;
    void connect(false);
  }

  function stop(): void {
    stopped = true;
    generation += 1;
    clearTimers();
    ready = false;
    if (socket) {
      const ws = socket;
      socket = null;
      try {
        ws.close(1000, 'logout');
      } catch {
        // Сокет уже закрыт.
      }
    }
    setStatus('offline');
  }

  // Очереди нет: пока соединения нет, интерфейс блокирует отправку,
  // и текст остаётся в поле ввода.
  function send(text: string): boolean {
    const { error, value } = validateMessage(text);
    if (error || !ready || !socket || socket.readyState !== WS_OPEN) return false;
    socket.send(encode({ type: 'CHAT_MESSAGE', payload: { text: value } }));
    return true;
  }

  return {
    start,
    stop,
    send,
    isReady: () => ready,
    getStatus: () => status,
  };
}
