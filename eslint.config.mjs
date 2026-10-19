import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    ignores: [
      'dist/**',
      'out/**',
      'node_modules/**',
      'resources/**',
      'test/**',
      'linglong/**',

      '**/*.ts',
      '**/*.tsx',
      '**/*.vue',
      '**/*.d.ts',
      '*.config.*',
      'electron-builder.yml'
    ]
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module'
    },
    rules: {
      'no-unused-vars': 'warn',
      'no-undef': 'off',
      'no-empty': 'off',
      'no-irregular-whitespace': 'off'
    }
  }
];
