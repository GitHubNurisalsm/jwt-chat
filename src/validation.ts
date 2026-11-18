// Клиентская валидация повторяет ограничения OpenAPI-схемы бекенда.
// Она нужна только для удобства: окончательно данные проверяет сервер.

export const USERNAME_MAX = 150;
export const PASSWORD_MIN = 6;

// В Django \w работает с Unicode, поэтому разрешены буквы любого алфавита.
const USERNAME_RE = /^[\p{L}\p{N}_.@+-]+$/u;

export interface LoginValues {
  username: string;
  password: string;
}

export interface RegistrationValues extends LoginValues {
  passwordConfirm: string;
}

export type FormErrors<T> = Partial<Record<keyof T, string>>;

export function validateUsername(username: string): string | null {
  const value = username.trim();
  if (!value) return 'Введите имя пользователя.';
  if (value.length > USERNAME_MAX) return `Не больше ${USERNAME_MAX} символов.`;
  if (!USERNAME_RE.test(value)) return 'Только буквы, цифры и символы @ . + - _';
  return null;
}

export function validateLogin({ username, password }: LoginValues): FormErrors<LoginValues> {
  const errors: FormErrors<LoginValues> = {};
  if (!username.trim()) errors.username = 'Введите имя пользователя.';
  if (!password) errors.password = 'Введите пароль.';
  return errors;
}

export function validateRegistration({
  username,
  password,
  passwordConfirm,
}: RegistrationValues): FormErrors<RegistrationValues> {
  const errors: FormErrors<RegistrationValues> = {};
  const usernameError = validateUsername(username);
  if (usernameError) errors.username = usernameError;
  if (password.length < PASSWORD_MIN) errors.password = `Минимум ${PASSWORD_MIN} символов.`;
  if (password !== passwordConfirm) errors.passwordConfirm = 'Пароли не совпадают.';
  return errors;
}
