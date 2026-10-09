// @vitest-environment jsdom
/**
 * パラメータの入力欄（fields.tsx）のテスト
 *
 * 確かめること:
 * - 配色の入力欄が、色の数だけ色見本を出すこと
 * - 色を追加する・減らすボタンがアイコンだけになっていて、名前は読み上げとホバーに残ること
 * - 選択肢パラメータは、選択肢の名前を並べた選択欄になり、選んだ値をそのまま渡すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ParamField } from './fields'
import type { ChoiceParamSpec, ColorsParamSpec } from './params'

/** 2〜4色まで選べる配色のパラメータ */
const paletteDeclaration: ColorsParamSpec = {
  type: 'colors',
  default: ['#112233', '#445566'],
  minCount: 2,
  maxCount: 4,
  description: '配色',
}

afterEach(cleanup)

describe('配色の入力欄', () => {
  test('色の数だけ色見本を出す', () => {
    render(<ParamField name="colors" spec={paletteDeclaration} value={['#112233', '#445566']} onChange={vi.fn()} />)

    expect(screen.getByLabelText('配色 1色目')).toHaveValue('#112233')
    expect(screen.getByLabelText('配色 2色目')).toHaveValue('#445566')
  })

  test('色を追加する・減らすはアイコンだけのボタンにし、名前は読み上げとホバー（title）に残す', () => {
    render(<ParamField name="colors" spec={paletteDeclaration} value={['#112233', '#445566']} onChange={vi.fn()} />)

    for (const name of ['色を追加する', '色を減らす']) {
      const button = screen.getByRole('button', { name })
      expect(button).toHaveTextContent('')
      expect(button).toHaveAttribute('title', name)
    }
  })
})

/** 札の枠を選ぶパラメータ */
const frameDeclaration: ChoiceParamSpec = {
  type: 'choice',
  default: 'board',
  choices: [
    { value: 'board', label: '板' },
    { value: 'sticky', label: '付箋' },
  ],
  description: '枠',
}

describe('選択肢の入力欄', () => {
  test('選択肢の名前を並べた選択欄にし、いまの値を選んでおく', () => {
    render(<ParamField name="frame" spec={frameDeclaration} value="sticky" onChange={vi.fn()} />)

    const select = screen.getByRole('combobox', { name: '枠' })
    expect(select).toHaveValue('sticky')
    expect(screen.getByRole('option', { name: '板' })).toHaveValue('board')
  })

  test('選び直すと、選んだ値をそのまま渡す', () => {
    const onChange = vi.fn()
    render(<ParamField name="frame" spec={frameDeclaration} value="board" onChange={onChange} />)

    fireEvent.change(screen.getByRole('combobox', { name: '枠' }), { target: { value: 'sticky' } })

    expect(onChange).toHaveBeenCalledWith('sticky')
  })
})
