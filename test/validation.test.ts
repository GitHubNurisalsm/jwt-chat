import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateLogin,
  validateRegistration,
  validateUsername,
} from '../src/validation.ts';

test('username: допустимые символы как в Django, включая кириллицу', () => {
  assert.equal(validateUsername('brian.may+1@queen_-'), null);
  assert.equal(validateUsername('Фредди'), null);
  assert.match(validateUsername('john deacon') ?? '', /Только/);
  assert.match(validateUsername('   ') ?? '', /Введите/);
  assert.equal(validateUsername('a'.repeat(150)), null);
  assert.match(validateUsername('a'.repeat(151)) ?? '', /150/);
});

test('регистрация: пароль минимум 6 символов и совпадение подтверждения', () => {
  assert.deepEqual(validateRegistration({ username: 'roger', password: '123456', passwordConfirm: '123456' }), {});
  const errors = validateRegistration({ username: 'roger', password: '12345', passwordConfirm: '54321' });
  assert.ok(errors.password);
  assert.ok(errors.passwordConfirm);
});

test('вход: пустые поля', () => {
  assert.deepEqual(Object.keys(validateLogin({ username: ' ', password: '' })).sort(), ['password', 'username']);
});
