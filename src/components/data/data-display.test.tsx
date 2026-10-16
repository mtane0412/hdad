// @vitest-environment jsdom
/**
 * データの型ごとの表示部品（data-display.tsx）のテスト。
 *
 * 一覧の中で「状態」「識別子」「数量」「色」「種類」を、文で書かずに型として見分けられる形で出すこと、
 * 値が無いときは 0 や空欄にせず「無い」と書くことを確かめる。
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { ColorSwatch, Identifier, Quantity, StatTile, StatusDot, Tag } from './data-display'

afterEach(cleanup)

describe('StatusDot', () => {
  test('状態の語を文字で出し、点は読み上げない', () => {
    // 前提: 交換できる状態の報酬
    const { container } = render(<StatusDot tone="positive">交換できる</StatusDot>)
    // 検証: 語は読める。点は飾りなので読み上げの対象から外れている
    expect(screen.getByText('交換できる')).toBeTruthy()
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })

  test('状態の種類を data-tone で持ち、見た目の色はトークンで決まる', () => {
    const { container } = render(<StatusDot tone="neutral">止めている</StatusDot>)
    expect(container.firstElementChild?.getAttribute('data-tone')).toBe('neutral')
  })
})

describe('Identifier', () => {
  test('識別子を等幅の code 要素で出す', () => {
    // 前提: ファイル名
    render(<Identifier>open-door.mp3</Identifier>)
    const code = screen.getByText('open-door.mp3')
    expect(code.tagName).toBe('CODE')
  })

  test('前に付ける記号（ログイン名の @ など）を添えられる', () => {
    render(<Identifier prefix="@">tanenob</Identifier>)
    expect(screen.getByText('@tanenob')).toBeTruthy()
  })
})

describe('Quantity', () => {
  test('数を3桁区切りで出し、単位を添える', () => {
    // 前提: 1500ポイントの報酬
    const { container } = render(<Quantity value={1500} unit="pt" />)
    expect(container.textContent).toBe('1,500pt')
    expect(screen.getByText('pt')).toBeTruthy()
  })

  test('値が無い（null）ときは 0 にせず「—」と書く', () => {
    const { container } = render(<Quantity value={null} unit="回" />)
    expect(container.textContent).toBe('—')
  })

  test('値が無いときの言葉を指定できる', () => {
    // 前提: 上限回数を決めていない報酬
    render(<Quantity value={null} unit="回" absent="制限なし" />)
    expect(screen.getByText('制限なし')).toBeTruthy()
  })

  test.each([
    ['NaN', Number.NaN],
    ['無限大', Number.POSITIVE_INFINITY],
  ])('数ではない値（%s）は、数のように見せず「数ではない値」と知らせる', (_label, value) => {
    render(<Quantity value={value} unit="pt" />)
    expect(screen.getByText('数ではない値')).toBeTruthy()
    expect(screen.queryByText('pt')).toBeNull()
  })

  test('0 は値として出す（無いこととは区別する）', () => {
    const { container } = render(<Quantity value={0} unit="秒" />)
    expect(container.textContent).toBe('0秒')
  })
})

describe('ColorSwatch', () => {
  test('色の見本を、色の名前を持つ画像として出す', () => {
    // 前提: 報酬の背景色
    render(<ColorSwatch color="#9147FF" label="背景色 #9147FF" />)
    const swatch = screen.getByRole('img', { name: '背景色 #9147FF' })
    expect(swatch.style.backgroundColor).not.toBe('')
  })
})

describe('Tag', () => {
  test('種類の名前を、色の点を添えた札で出す', () => {
    // 前提: トリガーの効果「アラート」
    const { container } = render(<Tag tone="orange">アラート</Tag>)
    expect(screen.getByText('アラート')).toBeTruthy()
    expect(container.firstElementChild?.getAttribute('data-tone')).toBe('orange')
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })
})

describe('StatTile', () => {
  test('見出しを名前にしたひとまとまりとして読ませ、値を見出しより大きく出す', () => {
    render(
      <StatTile label="平均視聴者数">
        <Quantity value={12} unit="人" />
      </StatTile>,
    )

    const tile = screen.getByRole('group', { name: '平均視聴者数' })
    expect(tile.textContent).toBe('平均視聴者数12人')
    // ダッシュボードと LLM のページで同じ大きさにそろえる
    expect((screen.getByText('12').closest('[data-slot="stat-value"]') as HTMLElement).className).toMatch(/\btext-xl\b/)
  })
})
