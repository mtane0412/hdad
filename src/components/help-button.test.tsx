// @vitest-environment jsdom
/**
 * ヘルプボタンのテスト
 *
 * 確かめること:
 * - 何の説明かを含む名前を、読み上げとホバー（title）に持つアイコンだけのボタンであること
 * - 説明は押すまで出さず、押したら出すこと（画面に常に説明文を並べないため）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import { HelpButton } from './help-button'

afterEach(cleanup)

describe('ヘルプボタン', () => {
  test('何の説明かを含む名前を持つ、アイコンだけのボタンを出す', () => {
    render(<HelpButton topic="VOICEVOX">CORSの許可が要ります</HelpButton>)

    const button = screen.getByRole('button', { name: 'VOICEVOXの説明' })
    expect(button).toHaveTextContent('')
    expect(button).toHaveAttribute('title', 'VOICEVOXの説明')
  })

  test('説明は押すまで出さず、押したら出す', async () => {
    render(<HelpButton topic="VOICEVOX">CORSの許可が要ります</HelpButton>)

    expect(screen.queryByText('CORSの許可が要ります')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'VOICEVOXの説明' }))

    expect(await screen.findByText('CORSの許可が要ります')).toBeInTheDocument()
  })
})
