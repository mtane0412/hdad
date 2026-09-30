// @vitest-environment jsdom
/**
 * 合成オーバーレイの構成のページ（オーバーレイと素材の編集、OBS用URL）のテスト
 *
 * 確かめること:
 * - 保存済みのオーバーレイと、その中の素材を前に出るものから出すこと（一覧の上が前）
 * - 素材を追加する・外す・並べ替える・別のオーバーレイへ移す・位置と大きさを直せること
 * - 配置用の枠に素材を四角として描き、ドラッグで動かす・端をつまんで大きさを変えられること
 * - オーバーレイ同士を一覧の中で並べ替えられること
 * - 素材のパラメータをスキーマの入力欄で調整でき、保存ではクエリ文字列になること
 * - オーバーレイを追加できること・オーバーレイごとのOBS用URLを出すこと
 * - 素材を1つも持たないオーバーレイは送らないこと
 * - Workerが返した問題点を、オーバーレイと素材の名前へ読み替えて並べること
 * - 保存済みの値が読めない素材でも、黙って捨てず理由を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../core/api'
import type { OverlayLayoutAdminApi } from './admin-api'
import type { Overlay, OverlayItem } from './layout'
import { OverlayPage } from './overlay-page'

const ISSUED_OVERLAY_KEY = 'issued-overlay-key-0123456789abcdefghij'

/** 背面いっぱいに敷いた壁紙 */
const wallpaper: OverlayItem = { kind: 'wallpaper', id: 'contour', params: '', rect: { x: 0, y: 0, width: 100, height: 100 } }

/** 前面の右下に置いた時計 */
const clock: OverlayItem = { kind: 'clock', id: 'analog', params: 'size=0.5', rect: { x: 78, y: 70, width: 20, height: 26 } }

/** アバターより後ろに置くオーバーレイ */
const back: Overlay = { name: 'back', items: [wallpaper] }

/** アバターより前に置くオーバーレイ */
const front: Overlay = { name: 'front', items: [clock] }

const fakeApi = (overrides: Partial<OverlayLayoutAdminApi> = {}): OverlayLayoutAdminApi => ({
  load: vi.fn(async () => [back, front]),
  save: vi.fn(async (overlays: readonly Overlay[]) => [...overlays]),
  ...overrides,
})

const renderPage = (api: OverlayLayoutAdminApi, overlayKey: string | null = ISSUED_OVERLAY_KEY) => render(<OverlayPage api={api} overlayKey={overlayKey} />)

/** オーバーレイ1つの領域（OBSのブラウザソース1つぶん） */
const overlayRegion = (name: string): Promise<HTMLElement> => screen.findByRole('group', { name: `オーバーレイ「${name}」` })

/** 素材1件の領域。呼び名（種類とデザイン名）で探す */
const materialRegion = async (overlayName: string, label: string): Promise<HTMLElement> =>
  within(await overlayRegion(overlayName)).getByRole('group', { name: label })

/** その素材を開いて入力欄を出す */
const openMaterial = async (overlayName: string, label: string): Promise<HTMLElement> => {
  const region = await materialRegion(overlayName, label)
  await userEvent.click(within(region).getByRole('button', { name: `${label}の設定` }))
  return region
}

const save = async (): Promise<void> => {
  await userEvent.click(screen.getByRole('button', { name: '構成を保存する' }))
}

afterEach(cleanup)

describe('オーバーレイと素材の一覧', () => {
  test('保存済みのオーバーレイを、その中の素材とともに出す', async () => {
    renderPage(fakeApi())

    expect(within(await overlayRegion('back')).getByRole('group', { name: '背景（Contour）' })).toBeInTheDocument()
    expect(within(await overlayRegion('front')).getByRole('group', { name: '時計（Analog）' })).toBeInTheDocument()
  })

  test('素材は前に出るものから並べる（一覧の上にあるものが前）', async () => {
    const api = fakeApi({ load: vi.fn(async () => [{ name: 'front', items: [clock, { ...wallpaper, id: 'grid' }] }]) })
    renderPage(api)

    // 構成では「あとのものが前」なので、一覧では並びを逆にして出す（上が前）
    const material = within(await overlayRegion('front')).getAllByRole('group')
    expect(material.map((element) => element.getAttribute('aria-label'))).toEqual(['背景（Grid）', '時計（Analog）'])
  })

  test('オーバーレイが1つも無ければ、まだ何も置いていないことを知らせる', async () => {
    renderPage(fakeApi({ load: vi.fn(async () => []) }))

    expect(await screen.findByText(/まだオーバーレイがありません/)).toBeInTheDocument()
  })

  test('読み込みに失敗したら理由を出す（空の構成として出さない）', async () => {
    renderPage(fakeApi({ load: vi.fn(async () => Promise.reject(new Error('Workerに届きませんでした'))) }))

    expect(await screen.findByText(/Workerに届きませんでした/)).toBeInTheDocument()
  })
})

/** 配置用の枠の大きさ（画素）。jsdom は要素の大きさを持たないので、ドラッグのテストでは差し替える */
const frameSize = { width: 400, height: 300 }

/**
 * 配置用の枠で四角をつまんで動かす。
 *
 * @param name つまむところの読み上げ名（「時計（Analog）を動かす」「時計（Analog）の右下をつまむ」）
 * @param dx 横に動かす画素（枠は 400px 幅なので、40px が 10％に当たる）
 * @param dy 縦に動かす画素（枠は 300px 高なので、30px が 10％に当たる）
 */
const dragHandle = async (overlayName: string, name: string, dx: number, dy: number): Promise<void> => {
  const handle = within(await overlayRegion(overlayName)).getByRole('button', { name })
  fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(window, { clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 })
  fireEvent.pointerUp(window, { clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 })
}

describe('配置用の枠', () => {
  beforeEach(() => {
    // jsdom はレイアウトを行わないので、枠の大きさ（画素 → ％の変換に要る）を差し替える
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      ...frameSize,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: frameSize.width,
      bottom: frameSize.height,
      toJSON: () => ({}),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('そのオーバーレイの素材を四角として描き、保存されている割合（％）を当てる', async () => {
    renderPage(fakeApi())

    const rect = within(await overlayRegion('front')).getByRole('button', { name: '時計（Analog）を動かす' })
    expect(rect.parentElement).toHaveStyle({ left: '78%', top: '70%', width: '20%', height: '26%' })
  })

  test('四角をドラッグすると、位置が数値欄にも出る（保存の形は割合のまま）', async () => {
    const api = fakeApi()
    renderPage(api)

    // 枠は 400 × 300px なので、40px 左へ・30px 上へ動かすと 10％ずつ動く
    await dragHandle('front', '時計（Analog）を動かす', -40, -30)
    await save()

    expect(api.save).toHaveBeenCalledWith([back, { name: 'front', items: [{ ...clock, rect: { x: 68, y: 60, width: 20, height: 26 } }] }])
  })

  test('端をつまむと大きさが変わる（つまんでいない側の端は動かない）', async () => {
    const api = fakeApi()
    renderPage(api)

    // 右下を左上へ 20px・30px（＝5％・10％）つまみ寄せる。左端と上端は動かない
    await dragHandle('front', '時計（Analog）の右下をつまむ', -20, -30)
    await save()

    expect(api.save).toHaveBeenCalledWith([back, { name: 'front', items: [{ ...clock, rect: { x: 78, y: 70, width: 15, height: 16 } }] }])
  })

  test('ドラッグが取り消されたら（指が離れずに中断されたら）そこで追うのをやめる', async () => {
    const api = fakeApi()
    renderPage(api)

    const handle = within(await overlayRegion('front')).getByRole('button', { name: '時計（Analog）を動かす' })
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 60, clientY: 100, pointerId: 1 })
    fireEvent.pointerCancel(window, { clientX: 60, clientY: 100, pointerId: 1 })
    // 取り消されたあとの動きは、つまんでいない指の動きなので位置を変えない
    fireEvent.pointerMove(window, { clientX: 300, clientY: 100, pointerId: 1 })
    await save()

    expect(api.save).toHaveBeenCalledWith([back, { name: 'front', items: [{ ...clock, rect: { x: 68, y: 70, width: 20, height: 26 } }] }])
  })

  test('四角をつまむと、その素材の設定が開く（どの四角がどの素材かを確かめられる）', async () => {
    renderPage(fakeApi())

    await dragHandle('front', '時計（Analog）を動かす', 0, 0)

    expect(within(await materialRegion('front', '時計（Analog）')).getByLabelText('左端の位置（％）')).toBeInTheDocument()
  })

  test('位置を数として読めない素材は四角にせず、その理由を出す', async () => {
    renderPage(fakeApi())

    const region = await openMaterial('front', '時計（Analog）')
    await userEvent.clear(within(region).getByLabelText('左端の位置（％）'))

    expect(within(await overlayRegion('front')).queryByRole('button', { name: '時計（Analog）を動かす' })).not.toBeInTheDocument()
    expect(within(await overlayRegion('front')).getByText(/枠に出せない素材があります/)).toBeInTheDocument()
  })
})

describe('素材の編集', () => {
  test('位置と大きさを直して保存する', async () => {
    const api = fakeApi()
    renderPage(api)

    const region = await openMaterial('front', '時計（Analog）')
    const width = within(region).getByLabelText('幅（％）')
    await userEvent.clear(width)
    await userEvent.type(width, '30')
    await save()

    expect(api.save).toHaveBeenCalledWith([back, { name: 'front', items: [{ ...clock, rect: { ...clock.rect, width: 30 } }] }])
  })

  test('位置の欄を空にしたら 0 に丸めず、そのまま送ってWorkerに理由を返させる', async () => {
    const api = fakeApi()
    renderPage(api)

    const region = await openMaterial('front', '時計（Analog）')
    await userEvent.clear(within(region).getByLabelText('左端の位置（％）'))
    await save()

    expect(api.save).toHaveBeenCalledWith([
      back,
      { name: 'front', items: [expect.objectContaining({ rect: expect.objectContaining({ x: Number.NaN }) })] },
    ])
  })

  test('デザインを変えると、そのデザインの素材として保存する', async () => {
    const api = fakeApi()
    renderPage(api)

    const region = await openMaterial('back', '背景（Contour）')
    await userEvent.selectOptions(within(region).getByLabelText('デザイン'), 'grid')
    await save()

    expect(api.save).toHaveBeenCalledWith([{ name: 'back', items: [{ ...wallpaper, id: 'grid' }] }, front])
  })

  test('素材のパラメータを調整すると、クエリ文字列にして保存する', async () => {
    const api = fakeApi()
    renderPage(api)

    const region = await openMaterial('front', '時計（Analog）')
    await userEvent.click(within(region).getByRole('checkbox', { name: '秒針を表示する' }))
    await save()

    expect(api.save).toHaveBeenCalledWith([back, { name: 'front', items: [{ ...clock, params: 'size=0.5&seconds=false' }] }])
  })

  test('素材を並べ替えると、重ねる順が入れ替わる', async () => {
    const api = fakeApi({ load: vi.fn(async () => [{ name: 'front', items: [clock, wallpaper] }]) })
    renderPage(api)

    const region = await materialRegion('front', '時計（Analog）')
    await userEvent.click(within(region).getByRole('button', { name: '時計（Analog）をひとつ前面へ' }))
    await save()

    expect(api.save).toHaveBeenCalledWith([{ name: 'front', items: [wallpaper, clock] }])
  })

  test('素材を別のオーバーレイへ移せる', async () => {
    const api = fakeApi()
    renderPage(api)

    const region = await openMaterial('front', '時計（Analog）')
    await userEvent.selectOptions(within(region).getByLabelText('置くオーバーレイ'), 'back')
    await save()

    // 移したあとの front は素材を持たなくなるので送らない
    expect(api.save).toHaveBeenCalledWith([{ name: 'back', items: [wallpaper, clock] }])
  })

  test('素材を外すときは、確かめてから外す', async () => {
    const api = fakeApi()
    renderPage(api)

    const region = await materialRegion('front', '時計（Analog）')
    await userEvent.click(within(region).getByRole('button', { name: '時計（Analog）を外す' }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '素材を外す' }))

    expect(within(await overlayRegion('front')).queryByRole('group', { name: '時計（Analog）' })).not.toBeInTheDocument()
    await save()
    expect(api.save).toHaveBeenCalledWith([back])
  })

  test('素材を追加すると、一覧のいちばん上（いちばん前）に付く', async () => {
    const api = fakeApi()
    renderPage(api)

    const region = await overlayRegion('front')
    await userEvent.selectOptions(within(region).getByLabelText('追加する素材の種類'), 'alerts')
    await userEvent.click(within(region).getByRole('button', { name: '素材を追加する' }))

    const material = within(await overlayRegion('front')).getAllByRole('group')
    expect(material.map((element) => element.getAttribute('aria-label'))).toEqual(['アラート', '時計（Analog）'])
  })

  test('素材を追加すると、そのオーバーレイのいちばん前に、いっぱいの大きさで付く', async () => {
    const api = fakeApi()
    renderPage(api)

    const region = await overlayRegion('front')
    await userEvent.selectOptions(within(region).getByLabelText('追加する素材の種類'), 'alerts')
    await userEvent.click(within(region).getByRole('button', { name: '素材を追加する' }))
    await save()

    expect(api.save).toHaveBeenCalledWith([
      back,
      { name: 'front', items: [clock, { kind: 'alerts', id: '', params: '', rect: { x: 0, y: 0, width: 100, height: 100 } }] },
    ])
  })
})

describe('オーバーレイ', () => {
  test('オーバーレイごとのOBS用URLを出す', async () => {
    renderPage(fakeApi())

    expect(within(await overlayRegion('back')).getByLabelText('OBSのブラウザソースに貼るURL')).toHaveValue(
      `${window.location.origin}/overlay/stage/?key=${encodeURIComponent(ISSUED_OVERLAY_KEY)}&overlay=back`,
    )
    expect(within(await overlayRegion('front')).getByLabelText('OBSのブラウザソースに貼るURL')).toHaveValue(
      `${window.location.origin}/overlay/stage/?key=${encodeURIComponent(ISSUED_OVERLAY_KEY)}&overlay=front`,
    )
  })

  test('オーバーレイを追加して素材を置くと、保存に入る', async () => {
    const api = fakeApi()
    renderPage(api)

    await userEvent.type(await screen.findByLabelText('追加するオーバーレイの名前'), 'talk')
    await userEvent.click(screen.getByRole('button', { name: 'オーバーレイを追加する' }))

    const region = await overlayRegion('talk')
    await userEvent.selectOptions(within(region).getByLabelText('追加する素材の種類'), 'focus')
    await userEvent.click(within(region).getByRole('button', { name: '素材を追加する' }))
    await save()

    expect(api.save).toHaveBeenCalledWith([
      back,
      front,
      { name: 'talk', items: [{ kind: 'focus', id: '', params: '', rect: { x: 0, y: 0, width: 100, height: 100 } }] },
    ])
  })

  test('名前を打つと、その名前の載ったOBS用URLをその場で見せる（名前とURLの関わりを文章で説明しない）', async () => {
    renderPage(fakeApi())

    await userEvent.type(await screen.findByLabelText('追加するオーバーレイの名前'), 'talk')

    expect(screen.getByText(`${window.location.origin}/overlay/stage/?key=…&overlay=talk`)).toBeInTheDocument()
  })

  test('URLは読み上げの通知に載せず、追加できない理由だけを通知する（1文字ごとにURL全体を読み上げさせない）', async () => {
    renderPage(fakeApi())
    const nameField = await screen.findByLabelText('追加するオーバーレイの名前')

    await userEvent.type(nameField, 'talk')
    expect(screen.getByText(`${window.location.origin}/overlay/stage/?key=…&overlay=talk`).closest('[aria-live]')).toBeNull()

    // すでにある名前に変えたときは、打っている手を止めずに伝わるよう通知に載せる
    await userEvent.clear(nameField)
    await userEvent.type(nameField, 'back')
    expect(screen.getByText(/この名前のオーバーレイはすでにあります/).closest('[aria-live]')).not.toBeNull()
  })

  test('すでにある名前を打つと、追加できない理由をその場で出す（押せないボタンを黙って出さない）', async () => {
    renderPage(fakeApi())

    await userEvent.type(await screen.findByLabelText('追加するオーバーレイの名前'), 'back')

    expect(screen.getByText(/この名前のオーバーレイはすでにあります/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'オーバーレイを追加する' })).toBeDisabled()
  })

  test('素材を1つも持たないオーバーレイは送らない（貼っても何も映らないURLを作らせない）', async () => {
    const api = fakeApi()
    renderPage(api)

    await userEvent.type(await screen.findByLabelText('追加するオーバーレイの名前'), 'talk')
    await userEvent.click(screen.getByRole('button', { name: 'オーバーレイを追加する' }))
    await save()

    expect(api.save).toHaveBeenCalledWith([back, front])
  })

  test('コマンドのボタンはアイコンだけにし、名前は読み上げとホバー（title）に残す', async () => {
    renderPage(fakeApi())
    const region = await overlayRegion('front')

    // 文字を出さないぶん、名前が読み上げからもホバーからも失われないことを確かめる
    for (const typedName of ['素材を追加する', 'URLをコピー', 'オーバーレイ「front」をひとつ上へ']) {
      const button = within(region).getByRole('button', { name: typedName })
      expect(button).toHaveTextContent('')
      expect(button).toHaveAttribute('title', typedName)
    }
  })

  test('素材が2つ以上あれば、一覧の上端と下端に前面・背面の目印を出す（並びの意味を文章で説明しない）', async () => {
    renderPage(fakeApi({ load: vi.fn(async () => [{ name: 'front', items: [wallpaper, clock] }]) }))

    const region = await overlayRegion('front')
    expect(within(region).getByText('前面')).toBeInTheDocument()
    expect(within(region).getByText('背面')).toBeInTheDocument()
  })

  test('素材が1つだけなら、前面・背面の目印は出さない（重なりが無いため）', async () => {
    renderPage(fakeApi({ load: vi.fn(async () => [front]) }))

    const region = await overlayRegion('front')
    expect(within(region).queryByText('前面')).not.toBeInTheDocument()
    expect(within(region).queryByText('背面')).not.toBeInTheDocument()
  })

  test('オーバーレイを並べ替えられる', async () => {
    const api = fakeApi()
    renderPage(api)

    await userEvent.click(within(await overlayRegion('front')).getByRole('button', { name: 'オーバーレイ「front」をひとつ上へ' }))
    await save()

    expect(api.save).toHaveBeenCalledWith([front, back])
  })

  test('端のオーバーレイは、その向きへは動かせない', async () => {
    renderPage(fakeApi())

    expect(within(await overlayRegion('back')).getByRole('button', { name: 'オーバーレイ「back」をひとつ上へ' })).toBeDisabled()
    expect(within(await overlayRegion('front')).getByRole('button', { name: 'オーバーレイ「front」をひとつ下へ' })).toBeDisabled()
  })

  test('オーバーレイを外すときは、確かめてから外す', async () => {
    const api = fakeApi()
    renderPage(api)

    await userEvent.click(within(await overlayRegion('front')).getByRole('button', { name: 'オーバーレイ「front」を外す' }))
    await userEvent.click(screen.getByRole('button', { name: 'オーバーレイを外す' }))
    await save()

    expect(api.save).toHaveBeenCalledWith([back])
  })

  test('オーバーレイ用キーが無ければ、URLの代わりに理由を出す', async () => {
    renderPage(fakeApi(), null)

    expect(await screen.findByText(/オーバーレイ用キーが発行されていません/)).toBeInTheDocument()
    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
  })
})

describe('保存', () => {
  test('入力を変えたら「未保存の変更があります」と添える', async () => {
    renderPage(fakeApi())

    const region = await openMaterial('front', '時計（Analog）')
    expect(screen.queryByText(/未保存の変更があります/)).not.toBeInTheDocument()

    await userEvent.click(within(region).getByRole('checkbox', { name: '秒針を表示する' }))

    expect(screen.getByText(/未保存の変更があります/)).toBeInTheDocument()
  })

  test('Workerが返した問題点は、オーバーレイと素材の名前へ読み替えて並べる', async () => {
    const problems = ['overlays[1].items[0].rect.width: 1〜100 の数（％）で指定してください']
    const api = fakeApi({
      save: vi.fn(async () => Promise.reject(new ApiError(400, 'invalid-config', 'オーバーレイの構成に問題があります', problems))),
    })
    renderPage(api)

    await overlayRegion('front')
    await save()

    expect(await screen.findByText(/「front」の「時計（Analog）」の 幅: 1〜100 の数（％）で指定してください/)).toBeInTheDocument()
  })
})

describe('保存済みの値が読めない素材', () => {
  test('黙って捨てず、理由を出す', async () => {
    const api = fakeApi({ load: vi.fn(async () => [{ name: 'front', items: [{ ...clock, id: 'sundial' }] }]) })
    renderPage(api)

    expect(await screen.findByText(/デザイン「sundial」は登録されていません/)).toBeInTheDocument()
    expect(await materialRegion('front', '時計（sundial）')).toBeInTheDocument()
  })
})

describe('プレビュー', () => {
  /** 枠の幅に合わせた縮小に使う ResizeObserver は jsdom に無いので、何も観測しない代役を置く */
  class fakeResizeObserver {
    observe(): void {
      // 縮小の倍率は見た目だけの話なので、テストでは観測しない
    }
    unobserve(): void {
      // 同上
    }
    disconnect(): void {
      // 同上
    }
  }

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', fakeResizeObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** そのオーバーレイのプレビューを開く（見ているあいだだけ動かすため、既定では閉じている） */
  const openPreview = async (name: string): Promise<HTMLElement> => {
    renderPage(fakeApi())
    const region = await overlayRegion(name)
    await userEvent.click(within(region).getByRole('button', { name: 'プレビューを見る' }))
    return region
  }

  test('開くまでは動かさない（配信中のものに加えてもう1組動かさないため）', async () => {
    renderPage(fakeApi())

    expect(within(await overlayRegion('front')).queryByTitle('オーバーレイ「front」のプレビュー')).not.toBeInTheDocument()
  })

  test('開くと合成ページを出す。素材の中身はサンプルで、オーバーレイ用キーは載せない', async () => {
    const region = await openPreview('front')

    expect(within(region).getByTitle('オーバーレイ「front」のプレビュー')).toHaveAttribute(
      'src',
      `${window.location.origin}/overlay/stage/?overlay=front&demo=true`,
    )
  })

  test('注意書きは開いているあいだだけ出す（閉じているカードで場所を取らない）', async () => {
    renderPage(fakeApi())
    expect(within(await overlayRegion('front')).queryByText(/中身はサンプルです/)).not.toBeInTheDocument()
    cleanup()

    const region = await openPreview('front')

    expect(within(region).getByText(/中身はサンプルです/)).toBeInTheDocument()
  })

  test('閉じると外す（見ているあいだだけ動かす）', async () => {
    const region = await openPreview('front')

    await userEvent.click(within(region).getByRole('button', { name: 'プレビューを閉じる' }))

    expect(within(region).queryByTitle('オーバーレイ「front」のプレビュー')).not.toBeInTheDocument()
  })

  test('プレビューが構成を待っていると知らせたら、編集中の構成を渡す（保存しなくても映る）', async () => {
    await openPreview('front')
    const region = await openMaterial('front', '時計（Analog）')
    await userEvent.clear(within(region).getByLabelText('幅（％）'))
    await userEvent.type(within(region).getByLabelText('幅（％）'), '40')

    const previewWindow = { postMessage: vi.fn() }
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'hdad-overlay-preview-ready' }, origin: window.location.origin, source: previewWindow as unknown as Window }),
    )

    expect(previewWindow.postMessage).toHaveBeenCalledWith(
      { type: 'hdad-overlay-preview-layout', overlays: [{ name: 'front', items: [{ ...clock, rect: { ...clock.rect, width: 40 } }] }] },
      window.location.origin,
    )
  })

  test('別のサイトからの知らせには構成を渡さない', async () => {
    await openPreview('front')

    const foreignWindow = { postMessage: vi.fn() }
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'hdad-overlay-preview-ready' }, origin: 'https://evil.example.com', source: foreignWindow as unknown as Window }),
    )

    expect(foreignWindow.postMessage).not.toHaveBeenCalled()
  })

  test('別のオーバーレイのプレビューを開くと、前のプレビューは閉じる（同時に動かすのは1つだけ）', async () => {
    await openPreview('front')

    const backRegion = await overlayRegion('back')
    await userEvent.click(within(backRegion).getByRole('button', { name: 'プレビューを見る' }))

    expect(within(backRegion).getByTitle('オーバーレイ「back」のプレビュー')).toBeInTheDocument()
    expect(within(await overlayRegion('front')).queryByTitle('オーバーレイ「front」のプレビュー')).not.toBeInTheDocument()
  })

  test('位置と大きさを数として読めない素材は映さず、その理由を出す', async () => {
    const region = await openPreview('front')
    await openMaterial('front', '時計（Analog）')
    await userEvent.clear(within(region).getByLabelText('幅（％）'))

    expect(within(region).getByText(/プレビューに出せない素材があります/)).toBeInTheDocument()
  })
})
