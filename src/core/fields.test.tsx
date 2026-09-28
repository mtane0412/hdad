// @vitest-environment jsdom
/**
 * パラメータの入力欄（fields.tsx）のテスト
 *
 * 確かめること:
 * - 配色の入力欄が、色の数だけ色見本を出すこと
 * - 色を足す・減らすボタンがアイコンだけになっていて、名前は読み上げとホバーに残ること
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ParamField } from './fields'
import type { ColorsParamSpec } from './params'

/** 2〜4色まで選べる配色のパラメータ */
const 配色の宣言: ColorsParamSpec = {
  type: 'colors',
  default: ['#112233', '#445566'],
  minCount: 2,
  maxCount: 4,
  description: '配色',
}

afterEach(cleanup)

describe('配色の入力欄', () => {
  test('色の数だけ色見本を出す', () => {
    render(<ParamField name="colors" spec={配色の宣言} value={['#112233', '#445566']} onChange={vi.fn()} />)

    expect(screen.getByLabelText('配色 1色目')).toHaveValue('#112233')
    expect(screen.getByLabelText('配色 2色目')).toHaveValue('#445566')
  })

  test('色を足す・減らすはアイコンだけのボタンにし、名前は読み上げとホバー（title）に残す', () => {
    render(<ParamField name="colors" spec={配色の宣言} value={['#112233', '#445566']} onChange={vi.fn()} />)

    for (const 名前 of ['色を足す', '色を減らす']) {
      const ボタン = screen.getByRole('button', { name: 名前 })
      expect(ボタン).toHaveTextContent('')
      expect(ボタン).toHaveAttribute('title', 名前)
    }
  })
})
