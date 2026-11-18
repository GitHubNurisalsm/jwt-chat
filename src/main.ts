import './style.css';
import { createApi, type ApiError, type User } from './api.ts';
import {
  createChatClient,
  MAX_MESSAGE_LENGTH,
  validateMessage,
  type ChatMessage,
  type ChatStatus,
} from './chat.ts';
import { validateLogin, validateRegistration } from './validation.ts';

// Элемент обязан существовать в index.html: если его нет, лучше упасть сразу.
function $<T extends Element = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Не найден элемент ${selector}`);
  return el;
}

type ViewName = 'loading' | 'auth' | 'chat';
type TabName = 'login' | 'register';

const views: Record<ViewName, HTMLElement> = {
  loading: $('#view-loading'),
  auth: $('#view-auth'),
  chat: $('#view-chat'),
};
const loginForm = $<HTMLFormElement>('#login-form');
const registerForm = $<HTMLFormElement>('#register-form');
const tabs: Record<TabName, HTMLButtonElement> = {
  login: $<HTMLButtonElement>('#tab-login'),
  register: $<HTMLButtonElement>('#tab-register'),
};

const composer = $<HTMLFormElement>('#composer');
const input = $<HTMLTextAreaElement>('#composer-input');
const sendBtn = $<HTMLButtonElement>('#send-btn');
const chatLog = $('#chat-log');
const list = $<HTMLOListElement>('#messages');
const emptyState = $('#chat-empty');
const statusEl = $('#chat-status');
const chatAlert = $('#chat-alert');
const banner = $('#banner');

// DOM не должен расти бесконечно, если вкладка открыта весь день.
const MAX_RENDERED_MESSAGES = 500;
// Сообщения одного автора подряд в пределах 5 минут показываются одной группой.
const GROUP_WINDOW_MS = 5 * 60 * 1000;

const STATUS_TEXT: Record<ChatStatus, string> = {
  connecting: 'Подключаемся…',
  reconnecting: 'Переподключаемся…',
  online: 'В сети',
  offline: 'Не подключено',
};

let currentUser: { username: string } | null = null;
let lastMessage: { sender: string; timestamp: number } | null = null;

const api = createApi({ onSessionExpired: () => handleSessionExpired() });

const chat = createChatClient({
  getToken: (options) => api.getAccessToken(options),
  onStatus: renderStatus,
  onReady: (username) => {
    // Имя из AUTH_SUCCESS — то, под которым сервер подписывает наши сообщения.
    if (username && currentUser) currentUser.username = username;
    hideChatAlert();
    renderSessionUser();
  },
  onMessage: appendMessage,
  onFatal: (reason) => {
    if (reason === 'session') return handleSessionExpired();
    showChatAlert('Сервер чата не принимает подключение. Попробуйте переподключиться позже.');
  },
});

// ---------- Экраны ----------

function showView(name: ViewName): void {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

function showBanner(text: string, isError = false): void {
  banner.textContent = text;
  banner.classList.toggle('is-error', isError);
  banner.hidden = !text;
}

function showAuth(): void {
  $('#session').hidden = true;
  showView('auth');
}

function renderSessionUser(): void {
  if (!currentUser) return;
  $('#session-user').textContent = `@${currentUser.username}`;
  $('#session').hidden = false;
}

function enterChat(user: User): void {
  currentUser = { username: user.username };
  renderSessionUser();
  showView('chat');
  chat.start();
  input.focus();
}

function resetChat(): void {
  chat.stop();
  currentUser = null;
  lastMessage = null;
  list.replaceChildren();
  emptyState.hidden = false;
  input.value = '';
  autosize();
  updateHint();
  hideChatAlert();
}

// Может вызываться и из api (refresh отклонён), и из чата: повторный вызов безопасен.
function handleSessionExpired(): void {
  if (!currentUser) return;
  resetChat();
  showAuth();
  showBanner('Сессия истекла. Войдите снова.', true);
}

// ---------- Чат ----------

function renderStatus(status: ChatStatus): void {
  statusEl.dataset.status = status;
  statusEl.textContent = STATUS_TEXT[status];
  input.disabled = status !== 'online';
  updateHint();
  if (status === 'online' && !views.chat.hidden) input.focus();
}

function showChatAlert(text: string): void {
  $('#chat-alert-text').textContent = text;
  chatAlert.hidden = false;
}

function hideChatAlert(): void {
  chatAlert.hidden = true;
}

const timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fullFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'medium' });

function isNearBottom(): boolean {
  return chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 80;
}

function appendMessage({ sender, text, timestamp }: ChatMessage): void {
  const stickToBottom = isNearBottom();
  const own = currentUser !== null && sender === currentUser.username;
  const continued =
    lastMessage !== null &&
    lastMessage.sender === sender &&
    timestamp - lastMessage.timestamp < GROUP_WINDOW_MS;
  lastMessage = { sender, timestamp };

  const item = document.createElement('li');
  item.className = 'message';
  item.classList.toggle('is-own', own);
  item.classList.toggle('is-continued', continued);

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const author = document.createElement('span');
  author.className = 'message-author';
  author.textContent = own ? 'Вы' : sender;
  const time = document.createElement('time');
  const date = new Date(timestamp);
  time.dateTime = date.toISOString();
  time.textContent = timeFormat.format(date);
  time.title = fullFormat.format(date);
  meta.append(author, time);

  // Только textContent: текст пишут другие пользователи, HTML в нём не исполняется.
  const body = document.createElement('p');
  body.className = 'message-text';
  body.textContent = text;

  item.append(meta, body);
  list.append(item);
  emptyState.hidden = true;

  while (list.children.length > MAX_RENDERED_MESSAGES) list.firstElementChild?.remove();
  if (stickToBottom || own) chatLog.scrollTop = chatLog.scrollHeight;
}

function updateHint(): void {
  const { value, error } = validateMessage(input.value);
  const hint = $('#composer-hint');
  if (error === 'too_long') {
    hint.textContent = `Слишком длинное сообщение: ${value.length} из ${MAX_MESSAGE_LENGTH}.`;
  } else if (value.length > MAX_MESSAGE_LENGTH * 0.8) {
    hint.textContent = `${value.length} / ${MAX_MESSAGE_LENGTH}`;
  } else {
    hint.textContent = '';
  }
  sendBtn.disabled = input.disabled || error !== null;
}

function autosize(): void {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  if (validateMessage(input.value).error) return;
  // Текст очищаем, только если сообщение реально ушло: при обрыве связи он не теряется.
  if (chat.send(input.value)) {
    input.value = '';
    autosize();
    updateHint();
  }
});

input.addEventListener('input', () => {
  autosize();
  updateHint();
});

input.addEventListener('keydown', (event) => {
  // isComposing: Enter при наборе через IME подтверждает слово, а не отправляет.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

$('#reconnect-btn').addEventListener('click', () => {
  hideChatAlert();
  chat.start();
});

// ---------- Ошибки форм ----------

function field(form: HTMLFormElement, name: string): HTMLInputElement {
  const el = form.elements.namedItem(name);
  if (!(el instanceof HTMLInputElement)) throw new Error(`Нет поля ${name}`);
  return el;
}

function clearErrors(form: HTMLFormElement): void {
  form.querySelectorAll('[data-error-for]').forEach((el) => (el.textContent = ''));
  form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  form.querySelector('[data-form-error]')!.textContent = '';
}

function showErrors(
  form: HTMLFormElement,
  fieldErrors: Record<string, string | undefined>,
  formError = '',
): void {
  let firstInvalid: HTMLElement | null = null;
  for (const [key, message] of Object.entries(fieldErrors)) {
    if (!message) continue;
    const slot = form.querySelector(`[data-error-for="${key}"]`);
    const target = form.elements.namedItem(key);
    if (!slot || !(target instanceof HTMLElement)) {
      formError = [formError, message].filter(Boolean).join(' ');
      continue;
    }
    slot.textContent = message;
    target.setAttribute('aria-invalid', 'true');
    firstInvalid ??= target;
  }
  form.querySelector('[data-form-error]')!.textContent = formError;
  firstInvalid?.focus();
}

// Блокирует кнопку на время запроса, чтобы не было повторной отправки.
async function withPending(form: HTMLFormElement, pendingText: string, action: () => Promise<void>) {
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  if (button.disabled) return;
  const idleText = button.textContent;
  button.disabled = true;
  button.textContent = pendingText;
  try {
    await action();
  } catch (err) {
    const apiErr = err as Partial<ApiError>;
    showErrors(form, apiErr.fieldErrors ?? {}, apiErr.message ?? 'Что-то пошло не так.');
  } finally {
    button.disabled = false;
    button.textContent = idleText;
  }
}

// ---------- Вкладки ----------

function selectTab(name: TabName, focus = false): void {
  for (const [key, tab] of Object.entries(tabs)) {
    const active = key === name;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  loginForm.hidden = name !== 'login';
  registerForm.hidden = name !== 'register';
  if (focus) tabs[name].focus();
}

tabs.login.addEventListener('click', () => selectTab('login'));
tabs.register.addEventListener('click', () => selectTab('register'));
$('[role="tablist"]').addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  selectTab(tabs.login.getAttribute('aria-selected') === 'true' ? 'register' : 'login', true);
});

// ---------- Вход, регистрация, выход ----------

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  clearErrors(loginForm);
  showBanner('');
  const values = {
    username: field(loginForm, 'username').value.trim(),
    password: field(loginForm, 'password').value,
  };
  const errors = validateLogin(values);
  if (Object.keys(errors).length) return showErrors(loginForm, errors);

  void withPending(loginForm, 'Входим…', async () => {
    const user = await api.login(values.username, values.password);
    loginForm.reset();
    enterChat(user);
  });
});

registerForm.addEventListener('submit', (event) => {
  event.preventDefault();
  clearErrors(registerForm);
  showBanner('');
  const values = {
    username: field(registerForm, 'username').value.trim(),
    password: field(registerForm, 'password').value,
    passwordConfirm: field(registerForm, 'passwordConfirm').value,
  };
  const errors = validateRegistration(values);
  if (Object.keys(errors).length) return showErrors(registerForm, errors);

  void withPending(registerForm, 'Создаём аккаунт…', async () => {
    const user = await api.register(values.username, values.password);
    registerForm.reset();
    enterChat(user);
    showBanner('Аккаунт создан. Добро пожаловать в чат!');
  });
});

$<HTMLButtonElement>('#logout-btn').addEventListener('click', async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  button.disabled = true;
  // Сначала закрываем сокет, чтобы после выхода в чат не ушло ни одного сообщения.
  resetChat();
  await api.logout();
  button.disabled = false;
  showBanner('Вы вышли из аккаунта.');
  selectTab('login');
  showAuth();
});

// ---------- Старт ----------

async function start(): Promise<void> {
  renderStatus('offline');
  try {
    const user = await api.restoreSession();
    if (user) enterChat(user);
    else showAuth();
  } catch (err) {
    showAuth();
    showBanner(err instanceof Error ? err.message : 'Не удалось проверить сессию.', true);
  }
}

void start();
