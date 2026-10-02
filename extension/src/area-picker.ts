/**
 * 映しているタブに差し込む「範囲を選ぶ画面」と、そこからサービスワーカーへの知らせの形（issue #166）
 *
 * 配信者がボタンの右クリック「映す範囲を選ぶ」を押すと、サービスワーカー（background.ts）が pickArea を
 * chrome.scripting.executeScript で映しているタブへ差し込む。配信者がページの上で矩形をドラッグして Enter を押すと、
 * 表示領域（タブの取り込みに映る範囲と同じ）に対する割合で chrome.runtime.sendMessage を使って知らせる。Esc でやめる。
 *
 * 選んでいるあいだの画面（暗い膜と枠）も配信に映るが、選び終えればすぐ消えるので、送るのを止めることはしない。
 *
 * 注意: pickArea は Chrome が文字列にしてタブへ送るので、このファイルのほかの値（定数・読み込んだもの）を参照できない。
 * 使う値はすべて関数の中に書き、あて先だけを引数で受け取る。
 * 注意: 知らせは executeScript の戻り値で受け取らない。選び終えるまでのあいだにサービスワーカーが眠ると受け取れないため
 * （知らせなら、届いたときにサービスワーカーが起きる）。
 */
import { isRecord } from './guards'

/** 範囲を選ぶ画面からの知らせに付けるあて先 */
export const AREA_PICKER_TARGET = 'area-picker'

/** 範囲を選ぶ画面から届く、選ばれた範囲（タブの表示領域に対する割合） */
export interface AreaPicked {
  readonly crop: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * 届いた連絡を読む。
 *
 * 形（4つの数）だけを確かめる。範囲がタブの中に収まっているかは、送り手（offscreen document）が受け取るときに
 * src/tab/crop.ts の parseTabCrop で確かめる（サービスワーカーが同じファイルを読み込むと、ビルドで共有のファイルができて zip に入らない）。
 *
 * @returns 範囲を選ぶ画面からの知らせでなければ null
 * @throws あて先が合っているのに形が違う場合（拡張の版が食い違っている）
 */
export const parseAreaPicked = (value: unknown): AreaPicked | null => {
  if (!isRecord(value) || value.target !== AREA_PICKER_TARGET) return null
  const crop = value.crop
  if (value.type !== 'picked' || !isRecord(crop) || !isNumber(crop.x) || !isNumber(crop.y) || !isNumber(crop.width) || !isNumber(crop.height)) {
    throw new Error('範囲を選ぶ画面からの知らせの形が想定と違います')
  }
  return { crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height } }
}

/**
 * 映しているタブの上に、映す範囲を選ぶ画面を出す（タブの中で動く）。
 *
 * - ドラッグで矩形を引く（引き直せる）。表示領域の外までドラッグしたら端で止める
 * - Enter で決めて知らせ、画面を片付ける。日本語入力の変換を確定する Enter では決めない
 * - Esc で知らせずに片付ける
 * - クリックしただけの小さな矩形では決めない（誤って一点を選び、映像が極端に拡大されないように）
 * - もう一度差し込まれたら、前の画面を片付けてから出し直す（Enter の受け口が2つ残って2回知らせないように）
 *
 * @param target 知らせのあて先（AREA_PICKER_TARGET。関数の外の値を参照できないので引数で受け取る）
 */
export function pickArea(target: string): void {
  /** 差し込んだ画面に付ける目印 */
  const MARKER = 'data-hdad-area-picker'
  /** 前の画面に片付けを頼む合図 */
  const CLOSE_EVENT = 'hdad-area-picker-close'
  /** 決められる矩形の最小の幅・高さ（ピクセル） */
  const MIN_SIZE = 8
  /** ページのどの要素よりも手前に出す */
  const TOPMOST = '2147483647'
  const DIM = 'rgba(0, 0, 0, 0.45)'

  for (const previous of document.querySelectorAll(`[${MARKER}]`)) previous.dispatchEvent(new Event(CLOSE_EVENT))

  const overlay = document.createElement('div')
  overlay.setAttribute(MARKER, '')
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-label', '映す範囲を選ぶ')
  overlay.tabIndex = -1
  Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: TOPMOST, cursor: 'crosshair', background: DIM })

  const frame = document.createElement('div')
  // 枠の外を暗くするため、大きな影で表示領域全体を覆う
  Object.assign(frame.style, { position: 'fixed', outline: '2px dashed #fff', boxShadow: `0 0 0 100vmax ${DIM}`, pointerEvents: 'none' })
  frame.hidden = true

  const hint = document.createElement('div')
  hint.textContent = 'ドラッグして映す範囲を選び、Enter で決めます（Esc でやめる）'
  Object.assign(hint.style, {
    position: 'fixed',
    top: '16px',
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '8px 16px',
    borderRadius: '8px',
    background: 'rgba(0, 0, 0, 0.8)',
    color: '#fff',
    font: '14px/1.5 system-ui, sans-serif',
    pointerEvents: 'none',
  })
  overlay.append(frame, hint)

  /** ドラッグを始めた位置（ドラッグしていなければ null） */
  let origin: { x: number; y: number } | null = null
  /** いま引いてある矩形（まだ引いていなければ null） */
  let area: { left: number; top: number; right: number; bottom: number } | null = null

  const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max)

  const draw = (): void => {
    if (area === null) return
    // 矩形を引いたら膜を透かし、枠の外だけを暗くする
    overlay.style.background = 'transparent'
    frame.hidden = false
    Object.assign(frame.style, {
      left: `${area.left}px`,
      top: `${area.top}px`,
      width: `${area.right - area.left}px`,
      height: `${area.bottom - area.top}px`,
    })
  }

  const onPointerDown = (event: MouseEvent): void => {
    event.preventDefault()
    origin = { x: clamp(event.clientX, window.innerWidth), y: clamp(event.clientY, window.innerHeight) }
    area = { left: origin.x, top: origin.y, right: origin.x, bottom: origin.y }
    draw()
  }

  const onPointerMove = (event: MouseEvent): void => {
    if (origin === null) return
    const x = clamp(event.clientX, window.innerWidth)
    const y = clamp(event.clientY, window.innerHeight)
    // どの向きにドラッグしても同じ矩形にする
    area = { left: Math.min(origin.x, x), top: Math.min(origin.y, y), right: Math.max(origin.x, x), bottom: Math.max(origin.y, y) }
    draw()
  }

  const onPointerUp = (event: MouseEvent): void => {
    onPointerMove(event)
    origin = null
  }

  const close = (): void => {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('keydown', onKeyDown, true)
    overlay.remove()
  }

  const decide = (): void => {
    if (area === null || area.right - area.left < MIN_SIZE || area.bottom - area.top < MIN_SIZE) return
    const width = window.innerWidth
    const height = window.innerHeight
    const crop = { x: area.left / width, y: area.top / height, width: (area.right - area.left) / width, height: (area.bottom - area.top) / height }
    chrome.runtime.sendMessage({ target, type: 'picked', crop }).catch((error: unknown) => {
      // 拡張が読み込み直された途中などで届かない。配信者はもう一度選び直せるので、原因を追えるよう記録する
      console.error('HDAD: 選んだ範囲を拡張へ知らせられませんでした', error)
    })
    close()
  }

  // ページ自身のキー操作より先に受け取り、ページへは渡さない（Enter でフォームが送られるなどを防ぐ）
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key !== 'Enter' || event.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    decide()
  }

  overlay.addEventListener('pointerdown', onPointerDown)
  overlay.addEventListener(CLOSE_EVENT, close)
  // 表示領域の外へドラッグしても追えるよう、動きと離したことは window で受ける
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('keydown', onKeyDown, true)
  document.documentElement.append(overlay)
  // 右クリックの項目を押した直後はページにキー入力が向いていないことがあるので、画面に向ける
  overlay.focus()
}
