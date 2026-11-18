import { defineConfig } from 'vite';

// Относительный base: сборка работает на GitHub Pages по адресу
// https://<user>.github.io/<repo>/ независимо от имени репозитория.
export default defineConfig({
  base: './',
});
