'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', '.prettierrc.js', '**/.eslintrc.js'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.es2020,
        ...globals.mocha,
      },
    },
    rules: {
      indent: ['error', 2, { SwitchCase: 1 }],
      'no-console': 'off',
      'no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_' }],
      'no-var': 'error',
      'no-trailing-spaces': 'error',
      'prefer-const': 'error',
      quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
      semi: ['error', 'always'],
    },
  },
];
