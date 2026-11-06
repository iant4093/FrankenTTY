// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'build/', 'release/', 'video/remotion/', 'coverage/', 'node_modules/', 'spikes/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { process: 'readonly', Buffer: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setImmediate: 'readonly' },
    },
    rules: {
      'no-console': ['error', { allow: ['error'] }],
      'no-control-regex': 'off',
    },
  },
  {
    files: ['tests/**', 'scripts/**'],
    rules: { 'no-console': 'off' },
  },
);
