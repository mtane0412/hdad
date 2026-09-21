// ESLint設定: TypeScript推奨ルールを適用する。ビルド成果物は対象外とする。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', '.wrangler/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
)
