# Общий чат — WebSocket + JWT

Групповой чат с регистрацией, входом и выходом. Писать могут только авторизованные пользователи. TypeScript + Vite, без фреймворков.

- Авторизация: [API](https://inai-col3.fishrungames.com/api/docs/) (`/register/`, `/login/`, `/token/refresh/`, `/logout/`, `/profile/`).
- Чат: `wss://inai-col3.fishrungames.com/chat/`.

## Запуск

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # node --test, Node 23.6+ (типы .ts убираются встроенно)
npm run verify     # tsc + тесты + production-сборка
```

## Как это работает

1. Вход или регистрация: `POST /login/` или `/register/` возвращают `access` в теле, а refresh-токен сервер кладёт в HttpOnly cookie.
2. Открывается WebSocket, и первым сообщением уходит `{"type":"AUTH","payload":{"token":"<access>"}}`.
3. После `AUTH_SUCCESS` поле ввода разблокируется, и сообщения уходят как `CHAT_MESSAGE`. Входящие `NEW_MESSAGE` выводятся в ленту.
4. При обрыве клиент переподключается с паузой 1 → 2 → 4 → 8 → 15 с, каждый раз со **свежим** access, полученным через refresh (старый мог истечь).
5. Если сокет открывается, но сервер трижды подряд рвёт его до `AUTH_SUCCESS`, клиент останавливается и предлагает переподключиться вручную, а не долбит сервер. Если refresh отклонён, это значит, что сессия истекла, и показывается экран входа.
6. Выход: сначала закрывается сокет, затем `POST /logout/` и очистка access в памяти.

Access-токен хранится только в памяти, не в localStorage. Текст сообщений выводится через `textContent`, поэтому HTML от других участников не исполняется.

## Файлы

- `src/api.ts` — HTTP-клиент: токены, единственный refresh при параллельных запросах, разбор ошибок DRF.
- `src/chat.ts` — WebSocket-клиент: типы протокола, рукопожатие AUTH, переподключение, защита от событий старых сокетов.
- `src/validation.ts` — проверки форм входа и регистрации.
- `src/main.ts` — интерфейс.
- `test/` — тесты на поддельных `fetch`, WebSocket и таймерах.

## Публикация

Push в `main` запускает `.github/workflows/deploy.yml`. Один раз включите **Settings → Pages → Source: GitHub Actions**.
