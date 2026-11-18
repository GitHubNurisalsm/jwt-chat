import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi, ApiError } from '../src/api.ts';

const BASE = 'https://api.test/api';
const USER = { id: 1, username: 'freddie', profile: { first_name: 'Freddie', specialization: 'vocals' } };

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Call extends RequestInit {
  path: string;
  auth: string | undefined;
}

type Handler = (call: Call, n: number) => Response | undefined | Promise<Response | undefined>;

// Мок fetch: вызывает обработчик для каждого запроса и сохраняет историю.
function mockFetch(handler: Handler) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = init.headers as Record<string, string>;
    const call: Call = { ...init, path: url.replace(BASE, ''), auth: headers.Authorization };
    calls.push(call);
    const res = await handler(call, calls.length);
    if (!res) throw new Error(`Неожиданный запрос ${call.path}`);
    return res;
  };
  return { calls, fetchImpl };
}

test('login сохраняет access и шлёт его как Bearer в /profile/', async () => {
  const { calls, fetchImpl } = mockFetch((call) => {
    if (call.path === '/login/') return json(200, { access: 'A1', user: USER });
    if (call.path === '/profile/') return json(200, USER);
  });
  const api = createApi({ baseUrl: BASE, fetchImpl });

  assert.deepEqual(await api.login('freddie', 'secret1'), USER);
  assert.deepEqual(JSON.parse(String(calls[0]?.body)), { username: 'freddie', password: 'secret1' });
  assert.equal(calls[0]?.auth, undefined, 'на /login/ access не отправляется');

  await api.getProfile();
  assert.equal(calls[1]?.auth, 'Bearer A1');
});

test('все запросы идут с credentials: include, иначе cookie с refresh не сохранится', async () => {
  const { calls, fetchImpl } = mockFetch((call) =>
    call.path === '/token/refresh/' ? json(200, { access: 'A2' }) : json(201, { access: 'A1', user: USER }),
  );
  const api = createApi({ baseUrl: BASE, fetchImpl });
  await api.register('freddie', 'secret1');
  await api.getAccessToken({ fresh: true });
  await api.logout();
  assert.ok(calls.every((c) => c.credentials === 'include'));
});

test('при 401 токен обновляется через refresh, запрос повторяется с новым access', async () => {
  const { calls, fetchImpl } = mockFetch((call) => {
    if (call.path === '/login/') return json(200, { access: 'OLD', user: USER });
    if (call.path === '/token/refresh/') return json(200, { access: 'NEW' });
    if (call.path === '/profile/') {
      return call.auth === 'Bearer NEW' ? json(200, USER) : json(401, { detail: 'Token is invalid or expired' });
    }
  });
  const api = createApi({ baseUrl: BASE, fetchImpl });
  await api.login('freddie', 'secret1');

  assert.deepEqual(await api.getProfile(), USER);
  assert.deepEqual(
    calls.map((c) => `${c.path} ${c.auth ?? '-'}`),
    ['/login/ -', '/profile/ Bearer OLD', '/token/refresh/ -', '/profile/ Bearer NEW'],
  );
});

test('параллельные 401 и переподключение сокета вызывают refresh только один раз', async () => {
  let refreshCount = 0;
  const { fetchImpl } = mockFetch(async (call) => {
    if (call.path === '/login/') return json(200, { access: 'OLD', user: USER });
    if (call.path === '/token/refresh/') {
      refreshCount += 1;
      await new Promise((r) => setTimeout(r, 10));
      return json(200, { access: 'NEW' });
    }
    return call.auth === 'Bearer NEW' ? json(200, USER) : json(401, { detail: 'expired' });
  });
  const api = createApi({ baseUrl: BASE, fetchImpl });
  await api.login('freddie', 'secret1');

  await Promise.all([api.getProfile(), api.getProfile(), api.getAccessToken({ fresh: true })]);
  assert.equal(refreshCount, 1);
});

test('если refresh отклонён, сессия сбрасывается и вызывается onSessionExpired', async () => {
  let expired = 0;
  const { fetchImpl } = mockFetch((call) => {
    if (call.path === '/login/') return json(200, { access: 'OLD', user: USER });
    if (call.path === '/token/refresh/') return json(401, { detail: 'Cookie refresh_token не найден.' });
    return json(401, { detail: 'expired' });
  });
  const api = createApi({ baseUrl: BASE, fetchImpl, onSessionExpired: () => (expired += 1) });
  await api.login('freddie', 'secret1');

  await assert.rejects(api.getProfile(), (err) => err instanceof ApiError && err.status === 401);
  assert.equal(expired, 1);
  assert.equal(api.isAuthenticated(), false);
});

test('после refresh второй 401 не зацикливает запросы', async () => {
  const { calls, fetchImpl } = mockFetch((call) => {
    if (call.path === '/token/refresh/') return json(200, { access: 'NEW' });
    return json(401, { detail: 'still bad' });
  });
  const api = createApi({ baseUrl: BASE, fetchImpl });
  await assert.rejects(api.getProfile(), { status: 401 });
  assert.ok(calls.length <= 4, `слишком много запросов: ${calls.length}`);
  assert.equal(api.isAuthenticated(), false);
});

test('restoreSession без cookie возвращает null и не вызывает onSessionExpired', async () => {
  let expired = 0;
  const { calls, fetchImpl } = mockFetch(() => json(401, { detail: 'Cookie refresh_token не найден.' }));
  const api = createApi({ baseUrl: BASE, fetchImpl, onSessionExpired: () => (expired += 1) });
  assert.equal(await api.restoreSession(), null);
  assert.equal(calls.length, 1);
  assert.equal(expired, 0);
});

test('restoreSession с действующей cookie возвращает пользователя', async () => {
  const { fetchImpl } = mockFetch((call) =>
    call.path === '/token/refresh/' ? json(200, { access: 'A1' }) : json(200, USER),
  );
  const api = createApi({ baseUrl: BASE, fetchImpl });
  assert.deepEqual(await api.restoreSession(), USER);
  assert.equal(api.isAuthenticated(), true);
});

test('logout удаляет access, даже если сервер недоступен', async () => {
  const { fetchImpl } = mockFetch((call) => {
    if (call.path === '/login/') return json(200, { access: 'A1', user: USER });
    throw new TypeError('Failed to fetch');
  });
  const api = createApi({ baseUrl: BASE, fetchImpl });
  await api.login('freddie', 'secret1');
  await api.logout();
  assert.equal(api.isAuthenticated(), false);
});

test('неверный пароль: ошибка с текстом сервера, токен не сохраняется', async () => {
  const { fetchImpl } = mockFetch(() => json(401, { detail: 'Неверный логин или пароль.' }));
  const api = createApi({ baseUrl: BASE, fetchImpl });
  await assert.rejects(api.login('freddie', 'wrong'), { status: 401, message: 'Неверный логин или пароль.' });
  assert.equal(api.isAuthenticated(), false);
});

test('ошибки полей DRF при регистрации раскладываются по полям', async () => {
  const { fetchImpl } = mockFetch(() =>
    json(400, { username: ['Пользователь с таким именем уже существует.'] }),
  );
  const api = createApi({ baseUrl: BASE, fetchImpl });
  await assert.rejects(api.register('freddie', 'secret1'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 400);
    assert.deepEqual(err.fieldErrors, { username: 'Пользователь с таким именем уже существует.' });
    return true;
  });
});

test('сетевая ошибка превращается в ApiError со статусом 0', async () => {
  const api = createApi({
    baseUrl: BASE,
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await assert.rejects(api.restoreSession(), (err) => err instanceof ApiError && err.status === 0);
});

test('HTML-ответ прокси (502 nginx) не попадает в текст ошибки', async () => {
  const api = createApi({
    baseUrl: BASE,
    fetchImpl: async () =>
      new Response('<html><head><title>502 Bad Gateway</title></head></html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
  });
  await assert.rejects(api.restoreSession(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 502);
    assert.doesNotMatch(err.message, /</);
    assert.match(err.message, /сервер/i);
    return true;
  });
});

test('если в ответе login нет user, профиль догружается отдельным запросом', async () => {
  const { fetchImpl } = mockFetch((call) =>
    call.path === '/login/' ? json(200, { access: 'A1' }) : json(200, USER),
  );
  const api = createApi({ baseUrl: BASE, fetchImpl });
  assert.deepEqual(await api.login('freddie', 'secret1'), USER);
});

// ---------- Токен для WebSocket ----------

test('getAccessToken: сразу после входа отдаёт текущий access без запросов', async () => {
  const { calls, fetchImpl } = mockFetch(() => json(200, { access: 'A1', user: USER }));
  const api = createApi({ baseUrl: BASE, fetchImpl });
  await api.login('freddie', 'secret1');
  assert.equal(await api.getAccessToken(), 'A1');
  assert.equal(calls.length, 1);
});

test('getAccessToken({fresh:true}) обновляет access через refresh-cookie', async () => {
  const { calls, fetchImpl } = mockFetch((call) =>
    call.path === '/token/refresh/' ? json(200, { access: 'A2' }) : json(200, { access: 'A1', user: USER }),
  );
  const api = createApi({ baseUrl: BASE, fetchImpl });
  await api.login('freddie', 'secret1');
  assert.equal(await api.getAccessToken({ fresh: true }), 'A2');
  assert.equal(calls.at(-1)?.path, '/token/refresh/');
  assert.equal(calls.at(-1)?.credentials, 'include');
});

test('getAccessToken: отклонённый refresh вызывает onSessionExpired и пробрасывает 401', async () => {
  let expired = 0;
  const { fetchImpl } = mockFetch((call) =>
    call.path === '/login/' ? json(200, { access: 'A1', user: USER }) : json(401, { detail: 'expired' }),
  );
  const api = createApi({ baseUrl: BASE, fetchImpl, onSessionExpired: () => (expired += 1) });
  await api.login('freddie', 'secret1');
  await assert.rejects(api.getAccessToken({ fresh: true }), { status: 401 });
  assert.equal(expired, 1);
  assert.equal(api.isAuthenticated(), false);
});

test('getAccessToken: сетевая ошибка при refresh не разлогинивает', async () => {
  let expired = 0;
  const { fetchImpl } = mockFetch((call) => {
    if (call.path === '/login/') return json(200, { access: 'A1', user: USER });
    throw new TypeError('Failed to fetch');
  });
  const api = createApi({ baseUrl: BASE, fetchImpl, onSessionExpired: () => (expired += 1) });
  await api.login('freddie', 'secret1');
  await assert.rejects(api.getAccessToken({ fresh: true }), { status: 0 });
  assert.equal(expired, 0);
  assert.equal(api.isAuthenticated(), true);
});
