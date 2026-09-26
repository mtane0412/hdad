// @vitest-environment jsdom
/**
 * ギャラリー（素材の一覧・調整用の入力欄・プレビュー・OBS用URL）のテスト
 *
 * 確かめること:
 * - レジストリの素材を一覧し、先頭の素材を選んだ状態で始まること
 * - スキーマの型ごとに入力欄が作られ、値を変えるとOBS用のURLに反映されること
 * - 「既定値に戻す」で入力欄とURLが元に戻ること
 * - URL欄に、ブラウザソースへ設定する推奨の幅と高さが添えられること
 * - URLをコピーできること。クリップボードを使えないときは、その旨を伝えること
 * - プレビューにだけ適用する値（previewOverrides）が、OBS用のURLには入らないこと
 * - ハッシュで素材を選べること。登録されていないIDは先頭の素材に置き換えず、エラーとして伝えること
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { Gallery, type GalleryItem } from './gallery'

const 水玉: GalleryItem = {
  id: 'mizutama',
  title: '水玉',
  description: '水玉が並ぶ背景。',
  schema: {
    speed: { type: 'number', default: 1, min: 0, max: 4, description: '動く速さ' },
    count: { type: 'number', default: 10, min: 1, max: 50, integer: true, description: '水玉の数' },
    bg: { type: 'color', default: '#112233', allowTransparent: true, description: '背景の色' },
    colors: { type: 'colors', default: ['#ff0000', '#00ff00'], minCount: 1, maxCount: 3, description: '水玉の配色' },
    glow: { type: 'boolean', default: false, description: '光らせる' },
    channel: { type: 'string', default: '', pattern: /^[a-z0-9_]+$/, example: 'your_channel', description: 'チャンネル名' },
  },
}

const 縞模様: GalleryItem = {
  id: 'shima',
  title: '縞模様',
  description: '縞が流れる背景。',
  schema: { width: { type: 'number', default: 20, min: 5, max: 100, integer: true, description: '縞の幅' } },
}

const 背景のギャラリー = (overrides: Partial<React.ComponentProps<typeof Gallery>> = {}) => (
  <Gallery definitions={[水玉, 縞模様]} noun="背景" basePath="/wallpaper/" previewSize={{ width: 1920, height: 1080 }} {...overrides} />
)

const URL欄 = (): HTMLElement => screen.getByRole('textbox', { name: 'OBSのブラウザソースに貼るURL' })
const 素材ページ = (path: string): string => `${window.location.origin}${path}`

/**
 * スライダーの入力要素を名前で探す。
 * Base UI の Slider は、つまみの位置を測り終えるまでつまみを visibility: hidden にする。jsdom は位置を測れず隠れたままなので、
 * 名前は外側の枠（role="group"）で確かめ、その中の入力要素を隠れた要素も含めて探す
 */
const スライダー = (name: string, scope: Pick<typeof screen, 'getByRole'> = screen): HTMLElement =>
  within(scope.getByRole('group', { name })).getByRole('slider', { hidden: true })

beforeAll(() => {
  // jsdom には ResizeObserver がない。プレビューの縮小率を決めるのに使うので、何もしない代役を置く
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  )
})

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
})

describe('素材の一覧', () => {
  test('レジストリの素材を並べ、先頭の素材を選んだ状態で始まる', () => {
    render(背景のギャラリー())

    const shelf = screen.getByRole('navigation', { name: '背景の一覧' })
    expect(within(shelf).getByRole('button', { name: '水玉' })).toHaveAttribute('aria-current', 'true')
    expect(within(shelf).getByRole('button', { name: '縞模様' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('heading', { level: 2, name: '水玉' })).toBeInTheDocument()
    expect(screen.getByText('水玉が並ぶ背景。')).toBeInTheDocument()
    expect(URL欄()).toHaveValue(素材ページ('/wallpaper/mizutama/'))
  })

  test('別の素材を選ぶと、その素材の入力欄とURLに切り替わり、ハッシュに選んだ素材が残る', async () => {
    render(背景のギャラリー())

    await userEvent.click(screen.getByRole('button', { name: '縞模様' }))

    expect(await screen.findByRole('heading', { level: 2, name: '縞模様' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#shima')
    expect(スライダー('縞の幅')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: '動く速さ' })).not.toBeInTheDocument()
    expect(URL欄()).toHaveValue(素材ページ('/wallpaper/shima/'))
  })

  test('ハッシュが指す素材を選んだ状態で始まる', () => {
    window.history.replaceState(null, '', '/wallpaper/#shima')
    render(背景のギャラリー())

    expect(screen.getByRole('heading', { level: 2, name: '縞模様' })).toBeInTheDocument()
  })

  test('登録されていないIDのハッシュでは、先頭の素材に置き換えずエラーを伝え、一覧から選び直せる', async () => {
    window.history.replaceState(null, '', '/wallpaper/#nai')
    render(背景のギャラリー())

    expect(screen.getByRole('alert')).toHaveTextContent('背景「nai」は登録されていません')
    expect(screen.queryByRole('textbox', { name: 'OBSのブラウザソースに貼るURL' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '水玉' }))
    expect(await screen.findByRole('heading', { level: 2, name: '水玉' })).toBeInTheDocument()
  })

  test('URLとして読めないハッシュ（% だけなど）でも落ちずに、登録されていないIDとして伝える', () => {
    window.history.replaceState(null, '', '/wallpaper/#%')
    render(背景のギャラリー())

    expect(screen.getByRole('alert')).toHaveTextContent('背景「%」は登録されていません')
  })

  test('レジストリが空なら、起動をやめてエラーにする', () => {
    // React がエラーを console.error にも出すので、テストの出力を汚さないよう黙らせる
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(背景のギャラリー({ definitions: [] }))).toThrow('レジストリに背景が1つも登録されていません')
    spy.mockRestore()
  })
})

describe('調整用の入力欄', () => {
  test('数値はスライダーで変えられ、URLに反映される', () => {
    render(背景のギャラリー())

    fireEvent.change(スライダー('水玉の数'), { target: { value: '25' } })

    expect(URL欄()).toHaveValue(素材ページ('/wallpaper/mizutama/?count=25'))
  })

  test('色を変えると、# を外した形でURLに反映される', () => {
    render(背景のギャラリー())

    fireEvent.input(screen.getByLabelText('背景の色'), { target: { value: '#abcdef' } })

    expect(URL欄()).toHaveValue(素材ページ('/wallpaper/mizutama/?bg=abcdef'))
  })

  test('透過にすると transparent になり、色は選べなくなる。解除すると元の色に戻る', async () => {
    render(背景のギャラリー())
    const 透過 = screen.getByRole('checkbox', { name: '透過にする' })

    await userEvent.click(透過)
    expect(URL欄()).toHaveValue(素材ページ('/wallpaper/mizutama/?bg=transparent'))
    expect(screen.getByLabelText('背景の色')).toBeDisabled()

    await userEvent.click(透過)
    expect(URL欄()).toHaveValue(素材ページ('/wallpaper/mizutama/'))
    expect(screen.getByLabelText('背景の色')).toBeEnabled()
  })

  test('配色は上限まで色を足せて、下限まで減らせる', async () => {
    render(背景のギャラリー())

    await userEvent.click(screen.getByRole('button', { name: '色を足す' }))
    expect(URL欄()).toHaveValue(素材ページ('/wallpaper/mizutama/?colors=ff0000,00ff00,ffffff'))
    expect(screen.getByLabelText('水玉の配色 3色目')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '色を足す' })).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: '色を減らす' }))
    await userEvent.click(screen.getByRole('button', { name: '色を減らす' }))
    expect(URL欄()).toHaveValue(素材ページ('/wallpaper/mizutama/?colors=ff0000'))
    expect(screen.getByRole('button', { name: '色を減らす' })).toBeDisabled()
  })

  test('真偽値はチェックで切り替えられる', async () => {
    render(背景のギャラリー())

    await userEvent.click(screen.getByRole('checkbox', { name: '光らせる' }))

    expect(URL欄()).toHaveValue(素材ページ('/wallpaper/mizutama/?glow=true'))
  })

  test('文字列は入力したままURLに反映される', async () => {
    render(背景のギャラリー())

    await userEvent.type(screen.getByRole('textbox', { name: 'チャンネル名' }), 'haishin_taro')

    expect(URL欄()).toHaveValue(素材ページ('/wallpaper/mizutama/?channel=haishin_taro'))
  })

  test('書式に合わない文字列は、直さずにそのままURLへ反映し、入力欄に誤りを示す', async () => {
    render(背景のギャラリー())
    const 入力欄 = screen.getByRole('textbox', { name: 'チャンネル名' })

    await userEvent.type(入力欄, 'だめな名前')

    expect(入力欄).toBeInvalid()
    expect(screen.getByText('書式に合いません（例: your_channel）')).toBeInTheDocument()
    expect(URL欄()).toHaveValue(素材ページ(`/wallpaper/mizutama/?channel=${encodeURIComponent('だめな名前')}`))
  })

  test('「既定値に戻す」で、入力欄とURLが元に戻る', async () => {
    render(背景のギャラリー())
    await userEvent.click(screen.getByRole('checkbox', { name: '光らせる' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'チャンネル名' }), 'haishin_taro')

    await userEvent.click(screen.getByRole('button', { name: '既定値に戻す' }))

    expect(URL欄()).toHaveValue(素材ページ('/wallpaper/mizutama/'))
    expect(screen.getByRole('checkbox', { name: '光らせる' })).not.toBeChecked()
    expect(screen.getByRole('textbox', { name: 'チャンネル名' })).toHaveValue('')
  })
})

describe('プレビュー', () => {
  test('実寸の大きさの iframe に、いまの値の素材ページを出す', async () => {
    render(背景のギャラリー())
    await userEvent.click(screen.getByRole('checkbox', { name: '光らせる' }))

    const preview = screen.getByTitle('背景のプレビュー')
    expect(preview).toHaveAttribute('width', '1920')
    expect(preview).toHaveAttribute('height', '1080')
    // 入力が落ち着いてから読み込み直すので、反映を待つ
    await waitFor(() => expect(screen.getByTitle('背景のプレビュー')).toHaveAttribute('src', 素材ページ('/wallpaper/mizutama/?glow=true')))
  })

  test('プレビューにだけ適用する値は、OBS用のURLには入らない', async () => {
    render(背景のギャラリー({ previewOverrides: { glow: true } }))

    expect(URL欄()).toHaveValue(素材ページ('/wallpaper/mizutama/'))
    await waitFor(() => expect(screen.getByTitle('背景のプレビュー')).toHaveAttribute('src', 素材ページ('/wallpaper/mizutama/?glow=true')))
  })
})

describe('OBS用のURL', () => {
  test('URL欄に、ブラウザソースへ設定する推奨の幅と高さを添える', () => {
    render(背景のギャラリー())

    expect(screen.getByText('推奨の大きさ: 1920 × 1080 px')).toBeInTheDocument()
  })

  test('推奨の大きさは、カテゴリごとに渡された実寸をそのまま出す', () => {
    render(背景のギャラリー({ previewSize: { width: 480, height: 800 } }))

    expect(screen.getByText('推奨の大きさ: 480 × 800 px')).toBeInTheDocument()
  })
})

describe('URLのコピー', () => {
  test('コピーしたら、貼り付け先を案内する', async () => {
    const user = userEvent.setup()
    render(背景のギャラリー())

    await user.click(screen.getByRole('button', { name: 'URLをコピー' }))

    expect(await screen.findByText(/URLをコピーしました/)).toBeInTheDocument()
    expect(await window.navigator.clipboard.readText()).toBe(素材ページ('/wallpaper/mizutama/'))
  })

  test('クリップボードを使えないときは、手動でコピーするよう伝える', async () => {
    render(背景のギャラリー())
    // https でも localhost でもないページでは navigator.clipboard が無い
    Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true })

    fireEvent.click(screen.getByRole('button', { name: 'URLをコピー' }))

    expect(await screen.findByText(/URLをコピーできませんでした/)).toBeInTheDocument()
  })
})
