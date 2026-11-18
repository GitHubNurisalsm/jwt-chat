import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createChatClient,
  retryDelay,
  validateMessage,
  MAX_MESSAGE_LENGTH,
  type ChatClientOptions,
  type ChatMessage,
  type ChatStatus,
  type ClientFrame,
  type FatalReason,
  type SocketFactory,
  type SocketLike,
  type TimerId,
} from '../src/chat.ts';

// Поддельный WebSocket: запоминает созданные сокеты и отправленные кадры,
// а тест сам решает, когда «сервер» открыл, ответил или закрыл соединение.
class FakeWebSocket implements SocketLike {
  readonly url: string;
  readyState = 0;
  sent: ClientFrame[] = [];
  closedByClient: { code: number | undefined; reason: string | undefined } | null = null;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;

  constructor(url: string, registry: FakeWebSocket[]) {
    this.url = url;
    registry.push(this);
  }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error('InvalidStateError');
    this.sent.push(JSON.parse(data) as ClientFrame);
  }
  close(code?: number, reason?: string): void {
    this.closedByClient = { code, reason };
    this.serverClose();
  }
  // --- управление со стороны теста ---
  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverSend(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }
  serverClose(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

function fakeSocketFactory() {
  const sockets: FakeWebSocket[] = [];
  const Factory: SocketFactory = class extends FakeWebSocket {
    constructor(url: string) {
      super(url, sockets);
    }
  };
  return { sockets, Factory };
}

// Ручные таймеры: тест явно запускает отложенные функции.
function fakeTimers() {
  const pending = new Map<TimerId, { fn: () => void; ms: number }>();
  let nextId = 1;
  return {
    pending,
    setTimer: (fn: () => void, ms: number): TimerId => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id: TimerId) => {
      pending.delete(id);
    },
    runAll() {
      const due = [...pending.values()];
      pending.clear();
      for (const t of due) t.fn();
    },
    delays: () => [...pending.values()].map((t) => t.ms),
  };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

function setup(overrides: Partial<ChatClientOptions> = {}) {
  const { sockets, Factory } = fakeSocketFactory();
  const timers = fakeTimers();
  const events = {
    statuses: [] as ChatStatus[],
    messages: [] as ChatMessage[],
    ready: [] as (string | null)[],
    fatal: [] as FatalReason[],
    tokenCalls: [] as { fresh: boolean }[],
  };
  let tokenN = 0;
  const client = createChatClient({
    url: 'wss://chat.test/chat/',
    WebSocketImpl: Factory,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    getToken: async (opts) => {
      events.tokenCalls.push(opts);
      tokenN += 1;
      return `T${tokenN}`;
    },
    onStatus: (s) => events.statuses.push(s),
    onMessage: (m) => events.messages.push(m),
    onReady: (u) => events.ready.push(u),
    onFatal: (r) => events.fatal.push(r),
    ...overrides,
  });
  return { client, sockets, timers, events };
}

type Ctx = ReturnType<typeof setup>;

// Последний созданный сокет; падает с понятной ошибкой, если сокета нет.
function lastSocket(ctx: Ctx): FakeWebSocket {
  const ws = ctx.sockets.at(-1);
  assert.ok(ws, 'сокет не создан');
  return ws;
}

function socketAt(ctx: Ctx, index: number): FakeWebSocket {
  const ws = ctx.sockets[index];
  assert.ok(ws, `нет сокета №${index}`);
  return ws;
}

async function connectAndAuth(ctx: Ctx, username = 'user1'): Promise<FakeWebSocket> {
  ctx.client.start();
  await flush();
  const ws = lastSocket(ctx);
  ws.serverOpen();
  ws.serverSend({ type: 'AUTH_SUCCESS', payload: { username } });
  return ws;
}

test('первым сообщением после open уходит AUTH с access-токеном', async () => {
  const ctx = setup();
  ctx.client.start();
  await flush();
  const ws = socketAt(ctx, 0);
  assert.equal(ws.url, 'wss://chat.test/chat/');
  assert.deepEqual(ctx.events.tokenCalls, [{ fresh: false }], 'при первом подключении берём текущий токен');

  ws.serverOpen();
  assert.deepEqual(ws.sent, [{ type: 'AUTH', payload: { token: 'T1' } }]);
});

test('до AUTH_SUCCESS сообщения не отправляются и входящие NEW_MESSAGE игнорируются', async () => {
  const ctx = setup();
  ctx.client.start();
  await flush();
  const ws = socketAt(ctx, 0);
  ws.serverOpen();

  assert.equal(ctx.client.send('рано'), false);
  ws.serverSend({ type: 'NEW_MESSAGE', payload: { sender: 'x', text: 'y', timestamp: 1 } });
  assert.equal(ws.sent.length, 1, 'кроме AUTH ничего не ушло');
  assert.equal(ctx.events.messages.length, 0);
  assert.equal(ctx.client.getStatus(), 'connecting');
});

test('после AUTH_SUCCESS: статус online, имя из payload, отправка CHAT_MESSAGE', async () => {
  const ctx = setup();
  const ws = await connectAndAuth(ctx, 'user1');

  assert.equal(ctx.client.getStatus(), 'online');
  assert.deepEqual(ctx.events.ready, ['user1']);
  assert.equal(ctx.client.send('  Всем привет  '), true);
  assert.deepEqual(ws.sent[1], { type: 'CHAT_MESSAGE', payload: { text: 'Всем привет' } });
});

test('NEW_MESSAGE передаётся в onMessage', async () => {
  const ctx = setup();
  const ws = await connectAndAuth(ctx);
  ws.serverSend({
    type: 'NEW_MESSAGE',
    payload: { sender: 'user1', text: 'Всем привет', timestamp: 1794203092682 },
  });
  assert.deepEqual(ctx.events.messages, [{ sender: 'user1', text: 'Всем привет', timestamp: 1794203092682 }]);
});

test('битые кадры и неизвестные типы не ломают клиент', async () => {
  const ctx = setup();
  const ws = await connectAndAuth(ctx);
  ws.serverSend('not json{');
  ws.serverSend('null');
  ws.serverSend({ type: 'SOMETHING_NEW', payload: {} });
  ws.serverSend({ type: 'NEW_MESSAGE', payload: { sender: 42, text: 'x' } });
  ws.serverSend({ type: 'NEW_MESSAGE' });
  ws.serverSend({ type: 'NEW_MESSAGE', payload: { sender: 'a', text: 'ok', timestamp: 'bad' } });

  assert.equal(ctx.events.messages.length, 1);
  const [message] = ctx.events.messages;
  assert.equal(message?.text, 'ok');
  assert.equal(typeof message?.timestamp, 'number', 'кривой timestamp заменён текущим временем');
  assert.equal(ctx.client.getStatus(), 'online');
});

test('пустое и слишком длинное сообщение не отправляется', async () => {
  const ctx = setup();
  const ws = await connectAndAuth(ctx);
  assert.equal(ctx.client.send('   \n '), false);
  assert.equal(ctx.client.send('a'.repeat(MAX_MESSAGE_LENGTH + 1)), false);
  assert.equal(ctx.client.send('a'.repeat(MAX_MESSAGE_LENGTH)), true);
  assert.equal(ws.sent.length, 2);
});

test('обрыв после входа: переподключение со свежим токеном и backoff', async () => {
  const ctx = setup();
  const ws1 = await connectAndAuth(ctx);
  ws1.serverClose();

  assert.equal(ctx.client.getStatus(), 'reconnecting');
  assert.equal(ctx.client.send('в пустоту'), false);
  assert.deepEqual(ctx.timers.delays(), [1000]);

  ctx.timers.runAll();
  await flush();
  assert.deepEqual(ctx.events.tokenCalls.at(-1), { fresh: true }, 'старый access мог истечь');
  const ws2 = socketAt(ctx, 1);
  ws2.serverOpen();
  assert.deepEqual(ws2.sent[0], { type: 'AUTH', payload: { token: 'T2' } });
  ws2.serverSend({ type: 'AUTH_SUCCESS', payload: { username: 'user1' } });
  assert.equal(ctx.client.getStatus(), 'online');
});

test('backoff растёт и ограничен 15 секундами', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map(retryDelay), [1000, 2000, 4000, 8000, 15000, 15000, 15000]);
});

test('сервер недоступен (сокет не открывается): попытки продолжаются, без onFatal', async () => {
  const ctx = setup();
  ctx.client.start();
  for (let i = 0; i < 6; i += 1) {
    await flush();
    lastSocket(ctx).serverClose();
    ctx.timers.runAll();
  }
  await flush();
  assert.equal(ctx.events.fatal.length, 0);
  assert.ok(ctx.sockets.length >= 6);
});

test('сервер раз за разом рвёт соединение после AUTH: остановка с onFatal("auth")', async () => {
  const ctx = setup({ maxAuthFailures: 3 });
  ctx.client.start();
  for (let i = 0; i < 3; i += 1) {
    await flush();
    const ws = lastSocket(ctx);
    ws.serverOpen();
    ws.serverClose(); // токен отклонён
    ctx.timers.runAll();
  }
  await flush();
  assert.deepEqual(ctx.events.fatal, ['auth']);
  assert.equal(ctx.sockets.length, 3, 'после остановки новых подключений нет');
  assert.equal(ctx.client.getStatus(), 'offline');
});

test('refresh отклонён (401) при переподключении: onFatal("session"), сокет не создаётся', async () => {
  let calls = 0;
  const ctx = setup({
    getToken: async () => {
      calls += 1;
      if (calls === 1) return 'T1';
      throw Object.assign(new Error('expired'), { status: 401 });
    },
  });
  const ws = await connectAndAuth(ctx);
  ws.serverClose();
  ctx.timers.runAll();
  await flush();
  assert.deepEqual(ctx.events.fatal, ['session']);
  assert.equal(ctx.sockets.length, 1);
  assert.equal(ctx.timers.pending.size, 0);
});

test('сетевая ошибка при получении токена: повтор позже, а не выход', async () => {
  let calls = 0;
  const ctx = setup({
    getToken: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('offline'), { status: 0 });
      return 'T2';
    },
  });
  ctx.client.start();
  await flush();
  assert.equal(ctx.sockets.length, 0);
  assert.equal(ctx.events.fatal.length, 0);
  ctx.timers.runAll();
  await flush();
  assert.equal(ctx.sockets.length, 1);
});

test('нет ответа на AUTH: соединение закрывается по таймауту', async () => {
  const ctx = setup({ authTimeoutMs: 5000 });
  ctx.client.start();
  await flush();
  const ws = socketAt(ctx, 0);
  ws.serverOpen();
  assert.deepEqual(ctx.timers.delays(), [5000]);
  ctx.timers.runAll();
  assert.ok(ws.closedByClient, 'клиент сам закрыл зависшее соединение');
  assert.equal(ctx.client.getStatus(), 'reconnecting');
});

test('stop (logout): сокет закрывается, переподключений и событий больше нет', async () => {
  const ctx = setup();
  const ws = await connectAndAuth(ctx);
  ctx.client.stop();

  assert.deepEqual(ws.closedByClient, { code: 1000, reason: 'logout' });
  assert.equal(ctx.client.getStatus(), 'offline');
  assert.equal(ctx.timers.pending.size, 0, 'retry не запланирован');
  assert.equal(ctx.client.send('после выхода'), false);

  ws.serverSend({ type: 'NEW_MESSAGE', payload: { sender: 'a', text: 'b', timestamp: 1 } });
  assert.equal(ctx.events.messages.length, 0);
  assert.equal(ctx.sockets.length, 1);
});

test('stop во время ожидания токена: запоздавший токен не открывает сокет', async () => {
  let resolveToken: (token: string) => void = () => {};
  const ctx = setup({ getToken: () => new Promise<string>((r) => (resolveToken = r)) });
  ctx.client.start();
  ctx.client.stop();
  resolveToken('LATE');
  await flush();
  assert.equal(ctx.sockets.length, 0);
});

test('повторный вход после logout: события старого сокета не влияют на новый', async () => {
  const ctx = setup();
  const oldWs = await connectAndAuth(ctx, 'alice');
  ctx.client.stop();
  const newWs = await connectAndAuth(ctx, 'bob');

  oldWs.onmessage?.({ data: JSON.stringify({ type: 'NEW_MESSAGE', payload: { sender: 'x', text: 'старое', timestamp: 1 } }) });
  oldWs.onclose?.({ code: 1006 });

  assert.equal(ctx.client.getStatus(), 'online');
  assert.equal(ctx.events.messages.length, 0);
  assert.equal(ctx.timers.pending.size, 0);
  assert.equal(ctx.client.send('hi'), true);
  assert.deepEqual(newWs.sent.at(-1), { type: 'CHAT_MESSAGE', payload: { text: 'hi' } });
});

test('повторный start не создаёт второй сокет', async () => {
  const ctx = setup();
  ctx.client.start();
  ctx.client.start();
  await flush();
  assert.equal(ctx.sockets.length, 1);
});

test('validateMessage обрезает пробелы и проверяет границы', () => {
  assert.deepEqual(validateMessage('  hi '), { error: null, value: 'hi' });
  assert.equal(validateMessage('').error, 'empty');
  assert.equal(validateMessage('x'.repeat(MAX_MESSAGE_LENGTH)).error, null);
  assert.equal(validateMessage('x'.repeat(MAX_MESSAGE_LENGTH + 1)).error, 'too_long');
});
