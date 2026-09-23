/**
 * 中継ページの表示
 *
 * 中継ページ自体は配信画面に映すものではないが、OBSのブラウザソースではコンソールを見られないため、
 * 接続の状態・拾えた確定文・Worker に記録できたかどうかをその場で読めるようにする。
 * 何も映さないページにすると、文字起こしが Worker へ届いていないことに配信が終わるまで気づけない。
 *
 * DOM を扱うのはここだけで、送る値を決める変換は message.ts が持つ。
 */

/** 画面に出せる件数の上限。長い配信でDOMが伸び続けないよう、古いものから落とす */
const MAX_LINES = 50

/** 1件の発話が、いまどうなっているか */
export type LineState =
  /** Worker へ送っている最中 */
  | 'sending'
  /** Worker が記録した */
  | 'recorded'
  /** 配信していなかったので Worker が捨てた */
  | 'discarded'
  /** 送信に失敗した（ゆかコネNEO が同じ1件を押し出し直せばやり直される） */
  | 'failed'
  /** ゆかコネNEO があとから取り消した */
  | 'deleted'

export interface TranscriptView {
  /** 接続の状態を書き換える */
  setStatus(text: string, connected: boolean): void
  /** 確定した発話を1件足す（送っている最中として出す） */
  addLine(messageId: string, text: string): void
  /** 足した発話の状態を書き換える */
  setLineState(messageId: string, state: LineState): void
  /** 失敗のお知らせを出す（null で消す） */
  setNotice(message: string | null): void
}

/** 状態ごとに行に添える印。OBSのブラウザソースで一目で分かるようにする */
const STATE_MARKS: Readonly<Record<LineState, string>> = {
  sending: '…',
  recorded: '✓',
  discarded: '配信外',
  failed: '送信失敗',
  deleted: '取り消し',
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

  /** 状態の書き換えに備えて、メッセージIDから画面の行を引けるようにしておく */
  const lines = new Map<string, HTMLLIElement>()

  const setState = (item: HTMLLIElement, state: LineState): void => {
    item.dataset.state = state
    const mark = item.querySelector('[data-mark]')
    if (mark) mark.textContent = STATE_MARKS[state]
  }

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
      const mark = document.createElement('span')
      mark.className = 'transcript-mark'
      mark.dataset.mark = ''

      item.append(time, body, mark)
      setState(item, 'sending')
      list.append(item)
      lines.set(messageId, item)

      while (lines.size > MAX_LINES) {
        const oldest = [...lines][0]
        if (!oldest) break
        oldest[1].remove()
        lines.delete(oldest[0])
      }
    },
    setLineState(messageId, state) {
      const item = lines.get(messageId)
      if (item) setState(item, state)
    },
    setNotice(message) {
      notice.textContent = message ?? ''
      notice.hidden = message === null
    },
  }
}
