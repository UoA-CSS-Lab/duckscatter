const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');
const prettierPlugin = require('eslint-plugin-prettier');
const prettierConfig = require('eslint-config-prettier');

module.exports = tseslint.config(
  // Base ESLint recommended config
  eslint.configs.recommended,

  // TypeScript ESLint recommended configs
  ...tseslint.configs.recommended,

  // Prettier integration
  {
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      ...prettierConfig.rules,
      'prettier/prettier': 'error',
    },
  },

  // Custom configuration
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'warn',
    },
  },

  // Files to ignore
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      '.github/scripts/**',
      '*.js',
      '*.d.ts',
      '*.config.js',
      '*.config.ts',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      '.vscode/**',
      '.idea/**',
      '*.tmp',
      '*.log',
      'temp/**',
      'tmp/**',
      'examples/**',
    ],
  }
);
