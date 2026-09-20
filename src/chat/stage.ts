/**
 * チャットボックスのページ（chat/<id>/index.html）のエントリスクリプト
 *
 * data-chat 属性に書かれたIDをレジストリから探し、URLのクエリパラメータを解析して、
 * Twitchのチャット（または ?demo=true のサンプル）を表示する。
 * 起動に失敗した場合は、OBS上でも原因が分かるよう画面にエラー内容を表示する。
 */
import { showError } from '../core/mount'
import { parseParams } from '../core/params'
import { connectChat } from './connection'
import { sourceOf } from './definition'
import { startDemo } from './demo'
import { applyEmotes, fetchJson, loadThirdPartyEmotes, type EmoteMap } from './emotes'
import { chats } from './registry'
import { createChatView } from './view'

const NOUN = 'チャットボックス'

const start = (): void => {
  const root = document.querySelector<HTMLElement>('[data-chat]')
  if (!root) throw new Error('data-chat 属性を持つ要素が見つかりません')

  const id = root.dataset.chat
  const definition = chats.find((candidate) => candidate.id === id)
  if (!definition) throw new Error(`${NOUN}「${id}」はレジストリに登録されていません`)

  const params = parseParams(definition.schema, new URLSearchParams(location.search))
  const source = sourceOf(params)
  for (const [name, value] of Object.entries(definition.cssVariables(params))) {
    root.style.setProperty(name, value)
  }

  const view = createChatView(root, params)
  if (source.type === 'demo') {
    startDemo(view)
    return
  }

  let thirdPartyEmotes: EmoteMap = new Map()
  let loadedRoomId: string | undefined

  /** サードパーティエモートを読み込む。ROOMSTATE は設定変更や再接続のたびに届くので、同じチャンネルでは1回だけにする */
  const loadEmotes = (roomId: string): void => {
    if (!params.thirdparty || roomId === loadedRoomId) return
    loadedRoomId = roomId
    void loadThirdPartyEmotes(roomId, fetchJson).then(({ emotes, failures }) => {
      thirdPartyEmotes = emotes
      // 一部のサービスが落ちていてもチャットは表示し続けるが、黙って無視せず画面に知らせる
      if (failures.length > 0) view.addNotice(`${failures.join('・')} のエモートを取得できませんでした`)
    })
  }

  connectChat(source.channel, {
    onEvent: (event) => {
      switch (event.type) {
        case 'message':
          view.add({ ...event.message, fragments: applyEmotes(event.message.fragments, thirdPartyEmotes) })
          break
        case 'clear-user':
          view.removeByLogin(event.login)
          break
        case 'clear-all':
          view.clear()
          break
        case 'delete':
          view.removeById(event.id)
          break
        case 'room':
          loadEmotes(event.roomId)
          break
        case 'notice':
          view.addNotice(event.text)
          break
      }
    },
    onStatus: (status) => {
      view.addNotice(
        status === 'disconnected' ? 'チャットとの接続が切れました。再接続します…' : 'チャットに再接続しました',
      )
    },
  })
}

try {
  start()
} catch (error) {
  showError(error, NOUN)
  throw error
}
