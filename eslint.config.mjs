import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      'contracts/lib/**',
      'contracts/out/**',
      'contracts/cache/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // The domain package is pure: no clock, no network, no env, no filesystem.
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'crypto'],
              message: 'packages/domain must stay I/O-free (ADR 0002).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'Domain logic must take `now` explicitly (ADR 0002).' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message: 'Pass `now` explicitly into domain functions.',
        },
        {
          object: 'process',
          property: 'env',
          message: 'packages/domain must not read the environment.',
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/test/**/*.ts', 'scripts/**/*.mjs'],
    rules: { 'no-console': 'off', 'no-restricted-globals': 'off' },
  },
);
