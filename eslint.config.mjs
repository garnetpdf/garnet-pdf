import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config({ ignores: ['out/**','release/**','node_modules/**','packages/**','fixtures/**','test-results/**','playwright-report/**'] }, js.configs.recommended, ...ts.configs.recommended, { files: ['**/*.{ts,tsx}'], rules: { '@typescript-eslint/no-explicit-any': 'error', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] } });
