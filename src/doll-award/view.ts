/**
 * 人形の獲得の素材の表示
 *
 * 届いた1件を HTML 要素として表示し、決まった時間のあとに消す。届くものは3種類ある（src/doll-award/call.ts）。
 * - 獲得: 人形の画像と文言（「◯◯さんが」「クマ人形 ×3 を獲得！」）。スーパー人形は見た目（doll-award.css の doll-award--super）で区別する
 * - 所持数: 「◯◯さんの人形」の見出しと、ふつう・スーパーの画像と個数を横に並べる（doll-standing）
 * - ランキング: 「人形ランキング」の見出しと点数の数え方、順位・名前・点数の表（doll-ranking）。行が多いので長めに出す
 * 下部バーの「演出を消す」を受けたら、時間を待たずにその場で消えさせる（dismiss）。
 * どの順で再生するかは呼び出し側（src/overlay/stage.ts の mountDollAward）が決める。
 */
import type { DollAwardCall, DollAwardMessage, DollRankingCall, DollStandingCall } from './call'
import { dollAwardCaption, dollRankingCaption, dollStandingCaption, type DollCountCaption } from './caption'

/** 獲得と所持数を出しておく長さ（ミリ秒）。現れる動きを含む */
export const SHOW_MS = 6_000
/** ランキングを出しておく長さ（ミリ秒）。何人ぶんも読むので、獲得より長くする */
export const RANKING_SHOW_MS = 10_000
/** 消えるときの動きの長さ（ミリ秒）。doll-award.css の doll-award-leave と合わせる */
const LEAVE_MS = 400

export interface DollAwardView {
  /**
   * 届いた1件を表示する。消え終わったら解決する。
   *
   * @throws 人形の画像を読み込めなかった場合（表示はすぐ片付ける）
   */
  show(message: DollAwardMessage): Promise<void>
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

/** 組み立てた1件ぶんの要素と、読み込みの失敗を見張る画像 */
interface BuiltItem {
  readonly item: HTMLDivElement
  readonly images: readonly HTMLImageElement[]
}

/** 人形の画像の要素を作る。文言が人形の名前を伝えるので、画像自体は装飾として扱う */
const dollImage = (className: string, imageUrl: string): HTMLImageElement => {
  const image = element('img', className)
  image.alt = ''
  image.src = imageUrl
  return image
}

/** 獲得1件ぶんの要素を組み立てる */
const createAwardElement = (call: DollAwardCall): BuiltItem => {
  const caption = dollAwardCaption(call)
  const item = element('div', call.kind === 'super' ? 'doll-award doll-award--super' : 'doll-award')

  const image = dollImage('doll-award__image', call.doll.imageUrl)

  const text = element('p', 'doll-award__text')
  const what = element('span', 'doll-award__name', caption.what)
  const line = element('span', 'doll-award__line')
  line.append(what)
  if (caption.count !== null) line.append(element('span', 'doll-award__count', caption.count))
  line.append(caption.suffix)
  text.append(element('span', 'doll-award__who', caption.who), line)

  item.append(image, text)
  return { item, images: [image] }
}

/** 所持数の人形1種類ぶん（画像の下に名前と個数）の要素を組み立てる */
const createHeldFigure = (className: string, imageUrl: string, caption: DollCountCaption): { column: HTMLDivElement; image: HTMLImageElement } => {
  const column = element('div', className)
  const image = dollImage('doll-standing__image', imageUrl)
  const label = element('p', 'doll-standing__label')
  label.append(element('span', 'doll-award__name', caption.name), element('span', 'doll-award__count', caption.count))
  column.append(image, label)
  return { column, image }
}

/** 1人ぶんの所持数の要素を組み立てる */
const createStandingElement = (call: DollStandingCall): BuiltItem => {
  const caption = dollStandingCaption(call)
  const item = element('div', 'doll-award doll-standing')
  const normal = createHeldFigure('doll-standing__figure', call.normal.imageUrl, caption.normal)
  const superFigure = createHeldFigure('doll-standing__figure doll-standing__figure--super', call.super.imageUrl, caption.super)
  const figures = element('div', 'doll-standing__figures')
  figures.append(normal.column, superFigure.column)
  item.append(element('p', 'doll-standing__title', caption.title), figures)
  return { item, images: [normal.image, superFigure.image] }
}

/** ランキングの要素を組み立てる */
const createRankingElement = (call: DollRankingCall): BuiltItem => {
  const caption = dollRankingCaption(call)
  const item = element('div', 'doll-award doll-ranking')

  const header = element('div', 'doll-ranking__header')
  const normalImage = dollImage('doll-ranking__image', call.normal.imageUrl)
  const superImage = dollImage('doll-ranking__image', call.super.imageUrl)
  const images = [normalImage, superImage]
  const heading = element('div', 'doll-ranking__heading')
  heading.append(element('p', 'doll-ranking__title', caption.title), element('p', 'doll-ranking__note', caption.note))
  header.append(normalImage, heading, superImage)
  item.append(header)

  if (caption.empty !== null) {
    item.append(element('p', 'doll-ranking__empty', caption.empty))
    return { item, images }
  }
  const list = element('ol', 'doll-ranking__list')
  for (const row of caption.rows) {
    const line = element('li', 'doll-ranking__row')
    line.append(element('span', 'doll-ranking__rank', row.rank), element('span', 'doll-ranking__name', row.name), element('span', 'doll-ranking__points', row.points))
    list.append(line)
  }
  item.append(list)
  return { item, images }
}

/** 届いたものの種類ごとに要素を組み立て、出しておく長さを決める */
const build = (message: DollAwardMessage): BuiltItem & { readonly showMs: number } => {
  switch (message.type) {
    case 'award':
      return { ...createAwardElement(message), showMs: SHOW_MS }
    case 'standing':
      return { ...createStandingElement(message), showMs: SHOW_MS }
    case 'ranking':
      return { ...createRankingElement(message), showMs: RANKING_SHOW_MS }
    default: {
      const exhaustive: never = message
      throw new Error(`知らない種類です: ${JSON.stringify(exhaustive)}`)
    }
  }
}

/** 画像の要素のうち、どの人形の画像かを失敗のメッセージに出すための名前 */
const describeMessage = (message: DollAwardMessage): string => (message.type === 'award' ? `人形「${message.doll.name}」` : `人形「${message.normal.name}」など`)

export const createDollAwardView = (root: HTMLElement): DollAwardView => {
  const notice = element('p', 'doll-awards__notice')
  notice.setAttribute('role', 'status')
  notice.hidden = true
  root.append(notice)

  /** 表示中の獲得を消えさせる。表示中でなければ null */
  let leaveNow: (() => void) | null = null

  return {
    show: (message) =>
      new Promise((resolve, reject) => {
        const { item, images, showMs } = build(message)

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
        const leaveTimer = window.setTimeout(leave, showMs)
        leaveNow = leave

        for (const image of images) {
          image.addEventListener('error', () => {
            // 2枚とも読めなかったときに2度片付けない
            if (!item.isConnected) return
            window.clearTimeout(leaveTimer)
            if (leaveNow === leave) leaveNow = null
            item.remove()
            reject(new Error(`${describeMessage(message)}の画像を読み込めませんでした`))
          })
        }

        root.append(item)
      }),

    setNotice: (text) => {
      notice.hidden = text === null
      notice.textContent = text ?? ''
    },

    dismiss: () => leaveNow?.(),
  }
}
