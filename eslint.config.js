// ESLint設定: TypeScript推奨ルールを適用する。ビルド成果物（本体の dist/ と拡張の public/tab-extension/）は対象外とする。
// あわせて、ページUIの見た目の約束（.claude/rules/design.md）として、色はトークンから・文字の大きさは段からだけ選ばせる。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * 色を取るユーティリティの頭。方向付きの枠線（border-t-）・リングのずれ（ring-offset-）・区切り線（divide-x-）も含める。
 * 前に付くのは空白・修飾子の : ・重要度の ! のどれか。
 */
const COLOR_UTILITY = String.raw`(text|bg|border(-[trblxyse])?|ring(-offset)?|outline|fill|stroke|from|via|to|decoration|divide(-[xy])?|placeholder|caret|accent|shadow|inset-shadow|inset-ring)`
const BOUNDARY = String.raw`(^|[\s:!])`
/** Tailwind の生の色（text-amber-500・border-t-red-500・bg-white など）。色は src/app/app.css のトークン（意味の名前）から取る */
const RAW_COLOR = new RegExp(
  `${BOUNDARY}${COLOR_UTILITY}-((red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\\d|white\\b|black\\b)`,
)
/**
 * 任意の値の文字の大きさ・色。text-[...] は中身を問わず禁止し（text-[10px]・text-[length:12px]）、
 * 色のユーティリティは色の書き方（#・色の関数・color:・CSS 変数）で始まる任意の値を禁止する。模様（repeating-conic-gradient など）は通す
 */
const ARBITRARY_TYPE_OR_COLOR = new RegExp(`${BOUNDARY}(text-\\[|${COLOR_UTILITY}-\\[(#|rgb|hsl|hwb|lab|lch|oklch|oklab|color|var\\())`)

const DESIGN_MESSAGE = '色は app.css のトークン（bg-attention など）から、文字の大きさは text-xs・text-sm・text-heading などの段から選んでください（.claude/rules/design.md）'

/**
 * ページの中の見出し（h2〜h6）に書いてはいけない大きさと太さ。見出しは大きさではなく太さ（font-semibold）で分ける。
 * ページの見出し（h1。text-heading）は対象外
 */
const HEADING_SIZE_OR_MEDIUM = String.raw`${BOUNDARY}(text-(base|lg|\d?xl)|font-medium)(?=$|\s)`
const HEADING_MESSAGE = 'ページの中の見出しは大きさではなく太さで分けます。text-base 以上の大きさや font-medium を使わず、font-semibold にしてください（.claude/rules/design.md）'

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
    rules: {
      'no-restricted-syntax': [
        'error',
        ...restrict(RAW_COLOR),
        ...restrict(ARBITRARY_TYPE_OR_COLOR),
        {
          selector: `JSXOpeningElement[name.name=/^h[2-6]$/] > JSXAttribute[name.name='className'] > Literal[value=/${HEADING_SIZE_OR_MEDIUM}/]`,
          message: HEADING_MESSAGE,
        },
      ],
    },
  },
)
