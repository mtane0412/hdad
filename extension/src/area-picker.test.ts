// @vitest-environment jsdom
/**
 * 映しているタブに差し込む「範囲を選ぶ画面」のテスト（issue #166）
 *
 * pickArea は chrome.scripting.executeScript で映しているタブへ差し込まれ、そのページの上で動く。
 * chrome.runtime.sendMessage は偽物に差し替え、次を確かめる。
 * - ドラッグした矩形を、ページの表示領域に対する割合にして、Enter で知らせる
 * - Esc ではなにも知らせずに画面を片付ける
 * - 小さすぎる矩形（クリックしただけ）では決めない
 * - 日本語入力の変換を確定する Enter では決めない
 * - もう一度差し込まれたら、前の画面を片付けてから出し直す
 * - 関数の文字列だけから動かしても動く（Chrome が文字列にして送るため）
 * また、サービスワーカーが受け取った知らせを読み分けられることを確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AREA_PICKER_TARGET, parseAreaPicked, pickArea } from './area-picker'

/** 差し込まれた画面の外枠（ドラッグを受ける） */
const overlay = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>('[data-hdad-area-picker]')
  if (element === null) throw new Error('範囲を選ぶ画面が出ていません')
  return element
}

const pointer = (type: string, x: number, y: number): void => {
  overlay().dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }))
}

const drag = (from: [number, number], to: [number, number]): void => {
  pointer('pointerdown', ...from)
  pointer('pointermove', ...to)
  pointer('pointerup', ...to)
}

const press = (key: string, init: KeyboardEventInit = {}): void => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
}

let sendMessage: ReturnType<typeof vi.fn>

beforeEach(() => {
  // 表示領域は 1000×500 とする
  vi.stubGlobal('innerWidth', 1000)
  vi.stubGlobal('innerHeight', 500)
  sendMessage = vi.fn(async () => undefined)
  vi.stubGlobal('chrome', { runtime: { sendMessage } })
})

afterEach(() => {
  // 決めずに終わったテストの画面を片付ける（次のテストに受け口を残さない）
  press('Escape')
  vi.unstubAllGlobals()
})

describe('pickArea', () => {
  it('ドラッグした矩形を、表示領域に対する割合にして Enter で知らせ、画面を片付ける', () => {
    pickArea(AREA_PICKER_TARGET)

    drag([500, 100], [750, 400])
    press('Enter')

    expect(sendMessage).toHaveBeenCalledWith({ target: AREA_PICKER_TARGET, type: 'picked', crop: { x: 0.5, y: 0.2, width: 0.25, height: 0.6 } })
    expect(document.querySelector('[data-hdad-area-picker]')).toBeNull()
  })

  it('右下から左上へドラッグしても、同じ矩形として扱う', () => {
    pickArea(AREA_PICKER_TARGET)

    drag([750, 400], [500, 100])
    press('Enter')

    expect(sendMessage).toHaveBeenCalledWith({ target: AREA_PICKER_TARGET, type: 'picked', crop: { x: 0.5, y: 0.2, width: 0.25, height: 0.6 } })
  })

  it('表示領域の外までドラッグしたら、端で止める', () => {
    pickArea(AREA_PICKER_TARGET)

    drag([500, 250], [1200, 600])
    press('Enter')

    expect(sendMessage).toHaveBeenCalledWith({ target: AREA_PICKER_TARGET, type: 'picked', crop: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } })
  })

  it('引き直したら、後の矩形で決める', () => {
    pickArea(AREA_PICKER_TARGET)

    drag([0, 0], [100, 100])
    drag([0, 0], [500, 500])
    press('Enter')

    expect(sendMessage).toHaveBeenCalledWith({ target: AREA_PICKER_TARGET, type: 'picked', crop: { x: 0, y: 0, width: 0.5, height: 1 } })
  })

  it('Esc では知らせずに画面を片付ける', () => {
    pickArea(AREA_PICKER_TARGET)

    drag([500, 100], [750, 400])
    press('Escape')

    expect(sendMessage).not.toHaveBeenCalled()
    expect(document.querySelector('[data-hdad-area-picker]')).toBeNull()
  })

  it('クリックしただけの小さな矩形では決めない', () => {
    pickArea(AREA_PICKER_TARGET)

    drag([500, 100], [503, 102])
    press('Enter')

    expect(sendMessage).not.toHaveBeenCalled()
    expect(document.querySelector('[data-hdad-area-picker]')).not.toBeNull()
  })

  it('日本語入力の変換を確定する Enter では決めない', () => {
    pickArea(AREA_PICKER_TARGET)

    drag([500, 100], [750, 400])
    press('Enter', { isComposing: true })

    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('関数の文字列だけから動かしても動く（Chrome は関数を文字列にしてタブへ送るので、ファイルのほかの値を参照できない）', () => {
    // new Function は外側のモジュールの値を見られないので、参照していれば ReferenceError になる
    const injected: unknown = new Function(`return (${pickArea.toString()})`)()
    if (typeof injected !== 'function') throw new Error('関数として読み戻せませんでした')
    injected(AREA_PICKER_TARGET)

    drag([500, 100], [750, 400])
    press('Enter')

    expect(sendMessage).toHaveBeenCalledWith({ target: AREA_PICKER_TARGET, type: 'picked', crop: { x: 0.5, y: 0.2, width: 0.25, height: 0.6 } })
  })

  it('もう一度差し込まれたら、前の画面を片付けてから出し直す', () => {
    pickArea(AREA_PICKER_TARGET)
    pickArea(AREA_PICKER_TARGET)

    drag([500, 100], [750, 400])
    press('Enter')

    expect(document.querySelectorAll('[data-hdad-area-picker]')).toHaveLength(0)
    // 前の画面の Enter の受け口が残っていれば、2回知らせてしまう
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})

describe('parseAreaPicked', () => {
  it('範囲を選ぶ画面からの知らせを読む', () => {
    expect(parseAreaPicked({ target: AREA_PICKER_TARGET, type: 'picked', crop: { x: 0.5, y: 0.2, width: 0.25, height: 0.6 } })).toEqual({
      crop: { x: 0.5, y: 0.2, width: 0.25, height: 0.6 },
    })
  })

  it('ほかのあて先の連絡は無視する（null を返す）', () => {
    expect(parseAreaPicked({ target: 'background', type: 'ended' })).toBeNull()
  })

  it('あて先が合っているのに形が違えばエラーにする', () => {
    expect(() => parseAreaPicked({ target: AREA_PICKER_TARGET, type: 'picked', crop: { x: '左', y: 0, width: 1, height: 1 } })).toThrow(
      '範囲を選ぶ画面からの知らせの形が想定と違います',
    )
  })
})
