/**
 * 注目コメントの表示
 *
 * 配信画面に出しっぱなしにする1件なので、DOMを扱うのはここだけにして、読み出し（api.ts）・
 * 何を映すかの判断（focused.ts）・起動（stage.ts）から切り離す。
 *
 * 組み立てる構造は次のとおりで、名前と本文を別々の要素として出す（CSSがそれぞれの大きさを決められるように）。
 *   <p class="focus-name">怖い話す人</p>
 *   <p class="focus-body">文字 <img class="focus-emote" /> 文字</p>
 *
 * 注意: 同じ1件を渡し直したときは要素を作り直さない。オーバーレイは30秒おきに読み直すので、
 * 毎回作り直すと出現のアニメーション（focus.css）が繰り返し走ってしまう（サイドスーパーと同じ扱い）。
 * 注意: 映すものが無ければ何も残さない。モデレーターに消された発言や、取り上げを外したあとの文言を
 * 配信画面に残さないためである。
 * 注意: 本文が空なら投げる（Fail-Fast）。名前だけのコメントが出ていると、映っているのに読めない
 * という状態になり、配信中は原因に気付けない。
 * 注意: 本文の長さで字の大きさの区分（data-length）を分ける。Twitchのチャットは1件500文字まで書けるので、
 * 短い発言に合わせた大きさのままだと、長い語りを取り上げたときに配信画面からあふれる。切り詰めると
 * 語りの途中が黙って消えるので、大きさのほうを変えて全文を収める（実際の大きさは focus.css が決める）。
 */
import type { Fragment } from '../chat/message'
import type { FocusedMessage } from './focused'

export interface FocusView {
  /** 映す1件を書き換える。映すものが無ければ null を渡す */
  setFocused(focused: FocusedMessage | null): void
}

const createEmoteImage = (url: string, name: string): HTMLImageElement => {
  const image = document.createElement('img')
  image.className = 'focus-emote'
  image.src = url
  image.alt = name
  return image
}

/**
 * 本文の断片1つを要素（または文字）にする。
 * Cheermote だけは、絵とビッツ数の2つになるため配列で返す（チャットボックスの view.ts と同じ扱い）。
 */
const createFragment = (fragment: Fragment): (string | Element)[] => {
  switch (fragment.type) {
    case 'text':
      return [fragment.text]
    case 'emote':
      return [createEmoteImage(fragment.url, fragment.name)]
    case 'cheer': {
      const amount = document.createElement('span')
      amount.className = 'focus-cheer-amount'
      amount.style.color = fragment.color
      amount.textContent = String(fragment.amount)
      return [createEmoteImage(fragment.url, fragment.name), amount]
    }
  }
}

/** 字の大きさの区分。短い発言は大きく、長い語りは小さくして、全文を配信画面に収める */
type BodyLength = 'short' | 'medium' | 'long'

/** この文字数までは大きいまま出す */
const SHORT_BODY_LENGTH = 40
/** この文字数までは中くらいの大きさで出す。超えたら小さくする */
const MEDIUM_BODY_LENGTH = 120

/** 本文の文字数。エモートと Cheermote は絵1つで1文字ぶんとして数える */
const bodyLengthOf = (fragments: readonly Fragment[]): number =>
  fragments.reduce((total, fragment) => total + (fragment.type === 'text' ? [...fragment.text].length : 1), 0)

/** 本文の長さから、字の大きさの区分を決める */
const lengthClassOf = (fragments: readonly Fragment[]): BodyLength => {
  const length = bodyLengthOf(fragments)
  if (length <= SHORT_BODY_LENGTH) return 'short'
  return length <= MEDIUM_BODY_LENGTH ? 'medium' : 'long'
}

/** 映す1件を見分ける鍵。本文まで含めるのは、取り上げた1件を配信者が書き換えた場合に作り直すためである */
const keyOf = (focused: FocusedMessage): string =>
  `${focused.messageId}\n${focused.displayName}\n${focused.fragments.map((fragment) => (fragment.type === 'text' ? fragment.text : fragment.name)).join('')}`

/**
 * 注目コメントの表示を組み立てる。
 *
 * @param root 表示を入れる要素（合成ページが作る [data-focus] の要素）
 */
export const createFocusView = (root: HTMLElement): FocusView => {
  /** いま映している1件の鍵。渡し直されたときに作り直すかどうかの判定に使う */
  let 映している鍵 = ''

  return {
    setFocused(focused) {
      if (focused === null) {
        if (映している鍵 === '') return
        映している鍵 = ''
        root.replaceChildren()
        return
      }
      if (focused.fragments.length === 0) {
        throw new Error(`「${focused.displayName}」の本文が空です（名前だけのコメントは映しません）`)
      }

      const 鍵 = keyOf(focused)
      if (鍵 === 映している鍵) return
      映している鍵 = 鍵

      const name = document.createElement('p')
      name.className = 'focus-name'
      name.textContent = focused.displayName
      const body = document.createElement('p')
      body.className = 'focus-body'
      body.dataset.length = lengthClassOf(focused.fragments)
      body.append(...focused.fragments.flatMap(createFragment))
      root.replaceChildren(name, body)
    },
  }
}
