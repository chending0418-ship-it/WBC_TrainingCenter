import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['apps/miniapp/dist/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
  { files: ['apps/web-admin/**/*.js'], languageOptions: { globals: globals.browser } }
);
