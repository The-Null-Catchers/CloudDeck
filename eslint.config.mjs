import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default [
  {ignores:['**/node_modules/**','**/dist/**','**/.next/**','**/next-env.d.ts']},
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {files:['**/*.tsx'],rules:{'react/no-unescaped-entities':'off'}},
];
