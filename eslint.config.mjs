import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';
export default [
  {ignores:['**/node_modules/**','**/dist/**','**/.next/**','**/next-env.d.ts']},
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {files:['apps/web/**/*.{ts,tsx}'],plugins:{'@next/next':nextPlugin},settings:{next:{rootDir:'apps/web/'}},rules:{...nextPlugin.configs.recommended.rules,'@next/next/no-html-link-for-pages':'off'}},
];
