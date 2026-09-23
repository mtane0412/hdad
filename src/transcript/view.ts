/**
 * 中継ページの表示
 *
 * 本番の中継ページは表示を持たなくてよいが、OBSのブラウザソースではコンソールを見られないため、
 * 接続の状態と受け取った確定文をそのまま画面に出す。ws:// への接続が通るかどうかを、OBS上で
 * 目で確かめるのがこのページの役目である（issue #64 の「先に確かめること」）。
 *
 * DOM を扱うのはここだけで、送る値を決める変換は message.ts が持つ。
 */

/** 画面に出せる件数の上限。長い配信でDOMが伸び続けないよう、古いものから落とす */
const MAX_LINES = 50

export interface TranscriptView {
  /** 接続の状態を書き換える */
  setStatus(text: string, connected: boolean): void
  /** 確定した発話を1件足す */
  addLine(messageId: string, text: string): void
  /** 送り済みの発話を取り消す（画面からは消さず、取り消したと分かる印を付ける） */
  removeLine(messageId: string): void
  /** 失敗のお知らせを出す（null で消す） */
  setNotice(message: string | null): void
}

/**
 * 中継ページの表示を組み立てる。
 *
 * @param root 表示を入れる要素（transcript/index.html の [data-transcript]）
 */
export const createTranscriptView = (root: HTMLElement): TranscriptView => {
  const status = document.createElement('p')
  status.className = 'transcript-status'
  status.setAttribute('role', 'status')

  const notice = document.createElement('pre')
  notice.className = 'transcript-notice'
  notice.setAttribute('role', 'alert')
  notice.hidden = true

  const list = document.createElement('ol')
  list.className = 'transcript-lines'

  root.append(status, notice, list)

  /** 取り消しに備えて、メッセージIDから画面の行を引けるようにしておく */
  const lines = new Map<string, HTMLLIElement>()

  return {
    setStatus(text, connected) {
      status.textContent = text
      status.dataset.connected = String(connected)
    },
    addLine(messageId, text) {
      const item = document.createElement('li')
      item.className = 'transcript-line'
      const time = document.createElement('time')
      time.textContent = new Date().toLocaleTimeString('ja-JP')
      const body = document.createElement('span')
      body.textContent = text
      item.append(time, body)
      list.append(item)
      lines.set(messageId, item)

      while (lines.size > MAX_LINES) {
        const [oldestId, oldest] = [...lines][0] ?? []
        if (oldestId === undefined || oldest === undefined) break
        oldest.remove()
        lines.delete(oldestId)
      }
    },
    removeLine(messageId) {
      lines.get(messageId)?.classList.add('transcript-line--deleted')
    },
    setNotice(message) {
      notice.textContent = message ?? ''
      notice.hidden = message === null
    },
  }
}
