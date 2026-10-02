/**
 * 拡張の設定ページの中身（映さないサイトの管理）
 *
 * 映さないサイトの一覧を出し、ホスト名を入力して登録し、消せるようにする。まだ開いていないサイト（銀行など）を前もって
 * 登録するためのもので、開いているサイトはボタンの右クリックでも登録・解除できる。
 *
 * 一覧は Worker が持つが、ここは Worker を直接呼ばずサービスワーカーに頼む（send）。サービスワーカーが覚えている一覧を
 * 更新し、映しているタブにもすぐ反映するため（controller.ts の handleSettingsRequest）。
 *
 * 注意: ホスト名の形は確かめない（検証は Worker だけが持つ）。拒まれたら理由をそのまま出し、入力は消さずに直させる。
 * 注意: サービスワーカー側のファイル（guards.ts など）は読み込まない（ビルドで共有のファイルができて zip に入らない）。
 */
import type { SettingsReply, SettingsRequest, SettingsRequestMessage } from './settings-request'

/** サービスワーカーへ頼み、返事（形は確かめていないもの）を受け取る */
export type SendSettingsRequest = (request: SettingsRequest) => Promise<unknown>

const isReply = (value: unknown): value is SettingsReply =>
  typeof value === 'object' &&
  value !== null &&
  'ok' in value &&
  ((value.ok === true && 'hosts' in value && Array.isArray(value.hosts) && value.hosts.every((host) => typeof host === 'string')) ||
    (value.ok === false && 'message' in value && typeof value.message === 'string'))

/** chrome.runtime.sendMessage で、サービスワーカーあてに頼む（あて先の値は settings-request.ts と同じものを直接書く） */
export const sendToServiceWorker: SendSettingsRequest = (request) => {
  const message: SettingsRequestMessage = { ...request, target: 'settings' }
  return chrome.runtime.sendMessage(message)
}

/** 要素を作る小さな手助け */
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, properties: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] =>
  Object.assign(document.createElement(tag), properties)

/**
 * 設定ページを root の末尾に組み立てる。
 *
 * @param send サービスワーカーへ頼む関数（テストでは偽物に差し替える）
 */
export const mountOptionsPage = (root: HTMLElement, send: SendSettingsRequest): void => {
  const input = element('input', { id: 'blocked-host', type: 'text', placeholder: '例: bank.example.jp', autocomplete: 'off', spellcheck: false })
  const label = element('label', { htmlFor: input.id, textContent: '映さないサイトのホスト名' })
  const submit = element('button', { type: 'submit', textContent: '登録する' })
  const form = element('form')
  form.append(input, submit)
  const failure = element('p', { className: 'failure', role: 'alert', hidden: true })
  const list = element('ul')
  const empty = element('p', { textContent: 'まだ登録していません。', hidden: true })
  root.append(label, form, failure, list, empty)

  const render = (hosts: readonly string[]): void => {
    list.replaceChildren(
      ...hosts.map((host) => {
        const remove = element('button', { type: 'button', textContent: '×', title: `${host} を一覧から消す` })
        remove.setAttribute('aria-label', `${host} を一覧から消す`)
        remove.addEventListener('click', () => void run({ type: 'remove', host }))
        const item = element('li')
        item.append(element('span', { className: 'host', textContent: host }), remove)
        return item
      }),
    )
    empty.hidden = hosts.length > 0
  }

  /**
   * 頼んで、うまくいったら一覧を出し直す。
   *
   * @returns うまくいったなら true
   */
  const run = async (request: SettingsRequest): Promise<boolean> => {
    // 登録の二重送信を防ぐ（消す操作は Worker が繰り返しても失敗にしないので止めない）
    submit.disabled = true
    failure.hidden = true
    try {
      const reply = await send(request)
      if (!isReply(reply)) throw new Error('サービスワーカーからの返事の形が想定と違います。拡張を読み込み直してください')
      if (!reply.ok) throw new Error(reply.message)
      render(reply.hosts)
      return true
    } catch (error) {
      failure.textContent = error instanceof Error ? error.message : String(error)
      failure.hidden = false
      return false
    } finally {
      submit.disabled = false
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void run({ type: 'add', host: input.value.trim() }).then((added) => {
      // 拒まれたときは入力を残し、直して登録し直せるようにする
      if (added) input.value = ''
    })
  })

  void run({ type: 'list' })
}
