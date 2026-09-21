/**
 * アラートの表示
 *
 * アラート1件を素材（画像・動画・音声）と文言のHTML要素として表示し、決まった秒数のあとに消す。
 * 見た目と出入りの動きは alerts.css が受け持つ。どの順で再生するかは呼び出し側（stage.ts と queue.ts）が決める。
 */
import type { Alert, AlertMedia } from './trigger'

/** 消えるときの動きの長さ（ミリ秒）。alerts.css の alert-leave と合わせる */
const LEAVE_MS = 400
const MILLISECONDS_PER_SECOND = 1000

export interface AlertView {
  /**
   * アラートを表示する。消え終わったら解決する。
   *
   * @throws 素材を読み込めなかった場合（表示はすぐ片付ける）
   */
  show(alert: Alert): Promise<void>
  /** 接続の状態などのお知らせを表示する。null で消す */
  setNotice(text: string | null): void
}

const createMediaElement = ({ kind, url }: AlertMedia, volume: number): HTMLImageElement | HTMLVideoElement | HTMLAudioElement => {
  if (kind === 'image') {
    const image = document.createElement('img')
    // 文言が内容を伝えるので、画像自体は装飾として扱う
    image.alt = ''
    image.src = url
    return image
  }
  const player = document.createElement(kind)
  player.autoplay = true
  player.volume = volume
  if (player instanceof HTMLVideoElement) player.playsInline = true
  player.src = url
  return player
}

export const createAlertView = (root: HTMLElement): AlertView => {
  const notice = document.createElement('p')
  notice.className = 'alerts__notice'
  notice.setAttribute('role', 'status')
  notice.hidden = true
  root.append(notice)

  return {
    show: (alert) =>
      new Promise((resolve, reject) => {
        const item = document.createElement('div')
        item.className = 'alert'
        const media = createMediaElement(alert.media, alert.volume)
        media.className = 'alert__media'
        item.append(media)
        if (alert.text !== '') {
          const text = document.createElement('p')
          text.className = 'alert__text'
          text.textContent = alert.text
          item.append(text)
        }

        const leaveTimer = window.setTimeout(() => {
          item.classList.add('alert--leaving')
          window.setTimeout(() => {
            item.remove()
            resolve()
          }, LEAVE_MS)
        }, alert.durationSeconds * MILLISECONDS_PER_SECOND)

        media.addEventListener('error', () => {
          window.clearTimeout(leaveTimer)
          item.remove()
          reject(new Error(`アラートの素材を読み込めませんでした: ${alert.media.url}`))
        })

        root.append(item)
      }),

    setNotice: (text) => {
      notice.hidden = text === null
      notice.textContent = text ?? ''
    },
  }
}
