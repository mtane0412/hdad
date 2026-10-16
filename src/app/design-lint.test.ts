/**
 * ページUIの見た目の約束（.claude/rules/design.md）を ESLint が守らせることを確かめる。
 *
 * 色は src/app/app.css のトークン（意味の名前）からだけ取り、文字の大きさは text-xs / text-sm / text-heading などの段からだけ選ぶ。
 * Tailwind の生の色（text-amber-500 など）と、任意の値の文字の大きさ・色（text-[10px]・bg-[#fff] など）を書くと Lint のエラーになる。
 * shadcn が生成した部品（src/components/ui/）は対象外にする。
 */
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, test } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))
const eslint = new ESLint({ cwd: root })

/** filePath に置いたつもりで code を Lint し、見た目の約束のエラーの件数を返す */
const designErrors = async (code: string, filePath = 'src/sample/sample-page.tsx'): Promise<number> => {
  const [result] = await eslint.lintText(code, { filePath: `${root}${filePath}` })
  return (result?.messages ?? []).filter((message) => message.ruleId === 'no-restricted-syntax').length
}

describe('見た目の約束の Lint', () => {
  test('生の色（text-amber-500）を className に書くとエラーになる', async () => {
    expect(await designErrors(`export const Badge = () => <span className="text-amber-500">未挨拶</span>`)).toBe(1)
  })

  test('白・黒（bg-white）もトークンではないのでエラーになる', async () => {
    expect(await designErrors(`export const Badge = () => <span className="bg-white">未挨拶</span>`)).toBe(1)
  })

  test('文字の大きさを任意の値（text-[10px]）で書くとエラーになる', async () => {
    expect(await designErrors(`export const Note = () => <span className="text-[10px]">補足</span>`)).toBe(1)
  })

  test('色を任意の値（bg-[#9147FF]）で書くとエラーになる', async () => {
    expect(await designErrors(`export const Swatch = () => <span className="bg-[#9147FF]" />`)).toBe(1)
  })

  test('テンプレート文字列の中の生の色もエラーになる', async () => {
    expect(await designErrors('export const dot = (on: boolean) => `size-2 ${on ? "bg-emerald-500" : ""}`')).toBe(1)
  })

  test('トークンの色・段の大きさ・配置の任意の値はエラーにならない', async () => {
    expect(
      await designErrors(
        `export const Row = () => <div className="grid grid-cols-[minmax(0,1fr)_auto] bg-attention text-xs text-muted-foreground">行</div>`,
      ),
    ).toBe(0)
  })

  test('shadcn が生成した部品（src/components/ui/）は対象外', async () => {
    expect(await designErrors(`export const Overlay = () => <div className="bg-black/10" />`, 'src/components/ui/sample.tsx')).toBe(0)
  })
})
