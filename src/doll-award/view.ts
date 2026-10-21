/**
 * 人形の獲得の表示
 *
 * 獲得1件を、人形の画像と文言（「◯◯さんが」「クマ人形 ×3 を獲得！」）のHTML要素として表示し、決まった時間のあとに消す。
 * スーパー人形は見た目（doll-award.css の doll-award--super）で区別する。
 * 下部バーの「演出を消す」を受けたら、時間を待たずにその場で消えさせる（dismiss）。
 * どの順で再生するかは呼び出し側（src/overlay/stage.ts の mountDollAward）が決める。
 */
import type { DollAwardCall } from './call'
import { dollAwardCaption } from './caption'

/** 1件を出しておく長さ（ミリ秒）。現れる動きを含む */
export const SHOW_MS = 6_000
/** 消えるときの動きの長さ（ミリ秒）。doll-award.css の doll-award-leave と合わせる */
const LEAVE_MS = 400

export interface DollAwardView {
  /**
   * 獲得を表示する。消え終わったら解決する。
   *
   * @throws 人形の画像を読み込めなかった場合（表示はすぐ片付ける）
   */
  show(call: DollAwardCall): Promise<void>
  /** 接続の状態などのお知らせを表示する。null で消す */
  setNotice(text: string | null): void
  /** 表示中の獲得を、時間を待たずに消えさせる（消え終わったら show が解決する）。表示中でなければ何もしない */
  dismiss(): void
}

/** クラス名と文字を持つ要素を作る */
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** 獲得1件ぶんの要素を組み立てる */
const createAwardElement = (call: DollAwardCall): { item: HTMLDivElement; image: HTMLImageElement } => {
  const caption = dollAwardCaption(call)
  const item = element('div', call.kind === 'super' ? 'doll-award doll-award--super' : 'doll-award')

  const image = element('img', 'doll-award__image')
  // 文言が人形の名前を伝えるので、画像自体は装飾として扱う
  image.alt = ''
  image.src = call.doll.imageUrl

  const text = element('p', 'doll-award__text')
  const what = element('span', 'doll-award__name', caption.what)
  const line = element('span', 'doll-award__line')
  line.append(what)
  if (caption.count !== null) line.append(element('span', 'doll-award__count', caption.count))
  line.append(caption.suffix)
  text.append(element('span', 'doll-award__who', caption.who), line)

  item.append(image, text)
  return { item, image }
}

export const createDollAwardView = (root: HTMLElement): DollAwardView => {
  const notice = element('p', 'doll-awards__notice')
  notice.setAttribute('role', 'status')
  notice.hidden = true
  root.append(notice)

  /** 表示中の獲得を消えさせる。表示中でなければ null */
  let leaveNow: (() => void) | null = null

  return {
    show: (call) =>
      new Promise((resolve, reject) => {
        const { item, image } = createAwardElement(call)

        /** 消えはじめる。時間がたったときと「演出を消す」を受けたときの両方から呼ぶので、2回目は何もしない */
        const leave = (): void => {
          if (leaveNow !== leave) return
          leaveNow = null
          window.clearTimeout(leaveTimer)
          item.classList.add('doll-award--leaving')
          window.setTimeout(() => {
            item.remove()
            resolve()
          }, LEAVE_MS)
        }
        const leaveTimer = window.setTimeout(leave, SHOW_MS)
        leaveNow = leave

        image.addEventListener('error', () => {
          window.clearTimeout(leaveTimer)
          if (leaveNow === leave) leaveNow = null
          item.remove()
          reject(new Error(`人形「${call.doll.name}」の画像を読み込めませんでした`))
        })

        root.append(item)
      }),

    setNotice: (text) => {
      notice.hidden = text === null
      notice.textContent = text ?? ''
    },

    dismiss: () => leaveNow?.(),
  }
}
