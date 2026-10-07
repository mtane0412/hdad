/**
 * ワイプの表示
 *
 * DOMを扱うのはここだけにして、変換（comment.ts）・順番の進め方（runner.ts）・起動（src/overlay/stage.ts）から切り離す。
 *
 * 組み立てる構造は次のとおり。素材の枠の右上にワイプの枠を置き、その下に吹き出しを出す（並びと大きさは wipe.css が決める）。
 *   <div class="wipe-scene">
 *     <div class="wipe-frame"><img class="wipe-icon" alt="" /></div>
 *     <div class="wipe-bubble">
 *       <p class="wipe-name">たねのぶ</p>
 *       <p class="wipe-body">こんにちは<img class="wipe-emote" alt="Kappa" /></p>
 *     </div>
 *   </div>
 *
 * 注意: 本文は textContent と img で組み立て、HTMLとして解釈しない（視聴者の書いた文字をそのまま出すため）。
 * 注意: 1件ごとに要素を作り直す。出現のアニメーション（wipe.css）を人が替わるたびに走らせるためである。
 */
import type { Fragment } from '../chat/message'
import type { ShownComment } from './runner'

export interface WipeView {
  /** 1件を出す（前の1件と入れ替える） */
  show(shown: ShownComment): void
  /** 引っ込める（何も残さない） */
  hide(): void
}

/** 絵（エモート・Cheermote）を、名前を代替文字にした img にする */
const createEmote = (name: string, url: string): HTMLImageElement => {
  const image = document.createElement('img')
  image.className = 'wipe-emote'
  image.src = url
  image.alt = name
  return image
}

/** 本文の断片1つを、文字か絵にする */
const createFragment = (fragment: Fragment): string | HTMLImageElement => {
  switch (fragment.type) {
    case 'text':
      return fragment.text
    case 'emote':
    case 'cheer':
      return createEmote(fragment.name, fragment.url)
  }
}

/** 1件ぶんの場面（吹き出しとワイプの枠）を組み立てる */
const createScene = ({ comment, profileImageUrl }: ShownComment): HTMLElement => {
  const name = document.createElement('p')
  name.className = 'wipe-name'
  name.textContent = comment.displayName

  const body = document.createElement('p')
  body.className = 'wipe-body'
  body.append(...comment.fragments.map(createFragment))

  const bubble = document.createElement('div')
  bubble.className = 'wipe-bubble'
  bubble.append(name, body)

  // アイコンは吹き出しの名前と同じ人を指す飾りなので、名前を繰り返さないよう代替文字を空にする
  const icon = document.createElement('img')
  icon.className = 'wipe-icon'
  icon.src = profileImageUrl
  icon.alt = ''

  const frame = document.createElement('div')
  frame.className = 'wipe-frame'
  frame.append(icon)

  const scene = document.createElement('div')
  scene.className = 'wipe-scene'
  scene.append(frame, bubble)
  return scene
}

/**
 * ワイプの表示を組み立てる。
 *
 * @param root 表示を入れる要素（合成ページが作る [data-wipe] の要素）
 */
export const createWipeView = (root: HTMLElement): WipeView => ({
  show(shown) {
    root.replaceChildren(createScene(shown))
  },
  hide() {
    root.replaceChildren()
  },
})
