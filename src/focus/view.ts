/**
 * 注目コメントの表示
 *
 * 配信画面に出しっぱなしにする1件なので、DOMを扱うのはここだけにして、読み出し（api.ts）・
 * 何を映すかの判断（focused.ts）・起動（stage.ts）から切り離す。
 *
 * 組み立てる構造は次のとおりで、アイコン・名前・本文を1つの箱にまとめる。それぞれを別々の要素にするのは、
 * CSS が大きさと並びを決められるようにするためである。
 *   <div class="focus-card">
 *     <img class="focus-icon" alt="" />
 *     <div class="focus-content">
 *       <p class="focus-name">怖い話す人</p>
 *       <p class="focus-body">今から怖い話をするね</p>
 *     </div>
 *   </div>
 *
 * 注意: 同じ1件を渡し直したときは要素を作り直さない。オーバーレイは10秒おきに読み直すので、
 * 毎回作り直すと出現のアニメーション（focus.css）が繰り返し走ってしまう（サイドスーパーと同じ扱い）。
 * 注意: 映すものが無ければ何も残さない。モデレーターに消された発言や、取り上げを外したあとの文言を
 * 配信画面に残さないためである。
 * 注意: 本文が空なら投げる（Fail-Fast）。名前だけのコメントが出ていると、映っているのに読めない
 * という状態になり、配信中は原因に気付けない。
 * 注意: 本文の長さで字の大きさの区分（data-length）を分ける。Twitchのチャットは1件500文字まで書けるので、
 * 短い発言に合わせた大きさのままだと、長い語りを取り上げたときに配信画面からあふれる。切り詰めると
 * 語りの途中が黙って消えるので、大きさのほうを変えて全文を収める（実際の大きさは focus.css が決める）。
 */
import type { FocusTarget } from './focused'

export interface FocusView {
  /** 映す1件を書き換える。映すものが無ければ null を渡す */
  setFocused(focused: FocusTarget | null): void
}

/** 字の大きさの区分。短い発言は大きく、長い語りは小さくして、全文を配信画面に収める */
type BodyLength = 'short' | 'medium' | 'long'

/** この文字数までは大きいまま出す */
const SHORT_BODY_LENGTH = 40
/** この文字数までは中くらいの大きさで出す。超えたら小さくする */
const MEDIUM_BODY_LENGTH = 120

/**
 * 本文の長さから、字の大きさの区分を決める。
 * 見た目の文字数（コードポイント）で数える（worker/focus-config.ts の上限の数え方と合わせる）
 */
const lengthClassOf = (text: string): BodyLength => {
  const length = [...text].length
  if (length <= SHORT_BODY_LENGTH) return 'short'
  return length <= MEDIUM_BODY_LENGTH ? 'medium' : 'long'
}

/** 映す1件を見分ける鍵。本文とアイコンまで含めるのは、同じ発言でも中身が変われば作り直すためである */
const keyOf = (focused: FocusTarget): string =>
  [focused.messageId, focused.displayName, focused.text, focused.profileImageUrl].join('\n')

/** 1件ぶんの箱を組み立てる */
const createCard = (focused: FocusTarget): HTMLElement => {
  // アイコンは隣の名前と同じ人を指す飾りなので、読み上げで名前を繰り返さないよう代替文字を空にする
  const icon = document.createElement('img')
  icon.className = 'focus-icon'
  icon.src = focused.profileImageUrl
  icon.alt = ''

  const name = document.createElement('p')
  name.className = 'focus-name'
  name.textContent = focused.displayName

  const body = document.createElement('p')
  body.className = 'focus-body'
  body.dataset.length = lengthClassOf(focused.text)
  body.textContent = focused.text

  const content = document.createElement('div')
  content.className = 'focus-content'
  content.append(name, body)

  const card = document.createElement('div')
  card.className = 'focus-card'
  card.append(icon, content)
  return card
}

/**
 * 注目コメントの表示を組み立てる。
 *
 * @param root 表示を入れる要素（合成ページが作る [data-focus] の要素）
 */
export const createFocusView = (root: HTMLElement): FocusView => {
  /** いま映している1件の鍵。渡し直されたときに作り直すかどうかの判定に使う */
  let showingKey = ''

  return {
    setFocused(focused) {
      if (focused === null) {
        if (showingKey === '') return
        showingKey = ''
        root.replaceChildren()
        return
      }
      if (focused.text === '') {
        throw new Error(`「${focused.displayName}」の本文が空です（名前だけのコメントは映しません）`)
      }

      const key = keyOf(focused)
      if (key === showingKey) return
      showingKey = key
      root.replaceChildren(createCard(focused))
    },
  }
}
