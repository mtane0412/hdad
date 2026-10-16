/**
 * ページUIの色のトークン（src/app/app.css）が、文字と背景の組み合わせごとに読める濃さの差を持つことを確かめる。
 *
 * 明るい表示（:root）と暗い表示（prefers-color-scheme: dark の :root）の両方を、
 * WCAG 2 のコントラスト比で測る。文字は 4.5:1、フォーカスの印のような文字でないものは 3:1 を下限にする。
 * トークンを書き換えたときに、見た目の好みで読みにくい組み合わせを作ってしまうのを防ぐためのテストである。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

/** 文字の下限（WCAG 2 の AA） */
const TEXT_MINIMUM = 4.5
/** 文字でないもの（フォーカスの印など）の下限（WCAG 2 の 1.4.11） */
const NON_TEXT_MINIMUM = 3

const css = readFileSync(fileURLToPath(new URL('./app.css', import.meta.url)), 'utf8')

/** 宣言のまとまり（`{ ... }` の中身）から `--名前: 値;` を読み出す */
const readTokens = (block: string): Map<string, string> =>
  new Map([...block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map(([, name = '', value = '']) => [name, value.trim()]))

/** 明るい表示のトークン。先頭の `:root {` から最初の `}` まで */
const lightBlock = css.match(/^:root\s*\{([^}]*)\}/m)
/** 暗い表示のトークン。`prefers-color-scheme: dark` の中の `:root {` から最初の `}` まで */
const darkBlock = css.match(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/)

/**
 * `oklch(L C H)` を、相対輝度（0〜1）に直す。透明度つき（`/ 10%` など）は背景に重ねて決まるので扱わない。
 * 変換は OKLab の定義（Björn Ottosson）に従い、OKLab → 線形 sRGB の行列を使う。
 */
const luminance = (value: string): number => {
  const match = value.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/)
  if (match === null) throw new Error(`oklch(L C H) の形ではない値です: ${value}`)
  const [, lightness = 0, chroma = 0, hueDegrees = 0] = match.map(Number)
  const hue = (hueDegrees * Math.PI) / 180
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clamp = (channel: number) => Math.min(1, Math.max(0, channel))
  const red = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)
  const green = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)
  const blue = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

/** 2つの色のコントラスト比（1〜21） */
const contrast = (first: string, second: string): number => {
  const lighter = Math.max(luminance(first), luminance(second))
  const darker = Math.min(luminance(first), luminance(second))
  return (lighter + 0.05) / (darker + 0.05)
}

/** 文字の色と、その文字が載る背景の組み合わせ */
const TEXT_PAIRS: readonly (readonly [text: string, background: string])[] = [
  ['foreground', 'background'],
  ['card-foreground', 'card'],
  ['popover-foreground', 'popover'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'muted'],
  ['primary-foreground', 'primary'],
  ['secondary-foreground', 'secondary'],
  ['accent-foreground', 'accent'],
  ['destructive', 'background'],
  ['sidebar-foreground', 'sidebar'],
  ['sidebar-accent-foreground', 'sidebar-accent'],
]

describe.each([
  ['明るい表示', lightBlock],
  ['暗い表示', darkBlock],
])('%s の色のトークン', (_label, block) => {
  const body = block?.[1]
  if (body === undefined) throw new Error('app.css からトークンのまとまりを読み出せませんでした')
  const tokens = readTokens(body)
  const token = (name: string): string => {
    const value = tokens.get(name)
    if (value === undefined) throw new Error(`--${name} が定義されていません`)
    return value
  }

  test.each(TEXT_PAIRS)('文字 --%s は背景 --%s の上で 4.5:1 以上の差がある', (text, background) => {
    expect(contrast(token(text), token(background))).toBeGreaterThanOrEqual(TEXT_MINIMUM)
  })

  test('フォーカスの印（--ring）は本文の背景の上で 3:1 以上の差がある', () => {
    expect(contrast(token('ring'), token('background'))).toBeGreaterThanOrEqual(NON_TEXT_MINIMUM)
  })

  test('フォーカスの印（--sidebar-ring）はサイドバーの背景の上で 3:1 以上の差がある', () => {
    expect(contrast(token('sidebar-ring'), token('sidebar'))).toBeGreaterThanOrEqual(NON_TEXT_MINIMUM)
  })
})
