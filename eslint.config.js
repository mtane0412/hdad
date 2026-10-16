// ESLint設定: TypeScript推奨ルールを適用する。ビルド成果物（本体の dist/ と拡張の public/tab-extension/）は対象外とする。
// あわせて、ページUIの見た目の約束（.claude/rules/design.md）として、色はトークンから・文字の大きさは段からだけ選ばせる。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/** Tailwind の生の色（text-amber-500・bg-white など）。色は src/app/app.css のトークン（意味の名前）から取る */
const RAW_COLOR =
  /(^|[\s:])(text|bg|border|ring|outline|fill|stroke|from|via|to|decoration|divide|placeholder|caret|accent|shadow)-((red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d|white\b|black\b)/
/** 任意の値の文字の大きさ（text-[10px]）と色（bg-[#fff]・text-[oklch(...)]）。大きさは text-xs などの段から選ぶ */
const ARBITRARY_TYPE_OR_COLOR = /(^|[\s:])(text-\[\d|[a-z]+-\[(#|rgb|hsl|oklch))/

const DESIGN_MESSAGE = '色は app.css のトークン（bg-attention など）から、文字の大きさは text-xs・text-sm・text-heading などの段から選んでください（.claude/rules/design.md）'

/** 文字列とテンプレート文字列の両方に同じ禁止をかける */
const restrict = (pattern) => [
  { selector: `Literal[value=/${pattern.source}/]`, message: DESIGN_MESSAGE },
  { selector: `TemplateElement[value.raw=/${pattern.source}/]`, message: DESIGN_MESSAGE },
]

export default tseslint.config(
  { ignores: ['dist/', 'public/tab-extension/', 'node_modules/', '.wrangler/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // ページUIだけに当てる。shadcn が生成した部品と、クラス名を文字列として確かめるテストは除く
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/components/ui/**', 'src/**/*.test.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...restrict(RAW_COLOR), ...restrict(ARBITRARY_TYPE_OR_COLOR)] },
  },
)
