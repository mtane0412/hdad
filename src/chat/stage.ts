/**
 * チャットボックスのページ（chat/<id>/index.html）のエントリスクリプト
 *
 * data-chat 属性に書かれたIDをレジストリから探し、URLのクエリパラメータを解析して、
 * Twitchのチャット（または ?demo=true のサンプル）を表示する。
 * 起動に失敗した場合は、OBS上でも原因が分かるよう画面にエラー内容を表示する。
 */
import { showError } from '../core/mount'
import { parseParams } from '../core/params'
import { badgeKey, loadBadges, type BadgeMap } from './badges'
import { applyCheermotes, loadCheermotes, type CheermoteMap } from './cheermotes'
import { connectChat } from './connection'
import { sourceOf } from './definition'
import { startDemo } from './demo'
import { applyEmotes, fetchJson, loadThirdPartyEmotes, type EmoteMap } from './emotes'
import { chats } from './registry'
import { createChatView } from './view'

const NOUN = 'チャットボックス'

// fetch をそのまま渡すと this が外れて Illegal invocation になるブラウザがあるので、包んで渡す
const callWorker: typeof fetch = (input, init) => fetch(input, init)

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

  let thirdPartyEmotes: EmoteMap = new Map()
  let officialBadges: BadgeMap = new Map()
  let cheermotes: CheermoteMap = new Map()
  let loadedRoomId: string | undefined

  const view = createChatView(root, {
    ...params,
    // 公式のバッジ画像は接続後に届くため、表示のたびに引き直す（届くまでは自前の絵が使われる）
    lookupBadge: (badge) => officialBadges.get(badgeKey(badge)),
  })
  if (source.type === 'demo') {
    startDemo(view)
    return
  }

  /**
   * チャンネルごとの素材（サードパーティエモート・公式バッジ・Cheermote）を読み込む。
   * ROOMSTATE は設定変更や再接続のたびに届くので、同じチャンネルでは1回だけにする。
   * どれも取得できなくてもチャットは表示し続けるが、黙って無視せず画面に知らせる。
   */
  const loadChannelAssets = (roomId: string): void => {
    if (roomId === loadedRoomId) return
    loadedRoomId = roomId

    if (params.thirdparty) {
      void loadThirdPartyEmotes(roomId, fetchJson).then(({ emotes, failures }) => {
        thirdPartyEmotes = emotes
        if (failures.length > 0) view.addNotice(`${failures.join('・')} のエモートを取得できませんでした`)
      })
    }
    if (params.badges) {
      void loadBadges(roomId, callWorker)
        .then((badges) => {
          officialBadges = badges
        })
        .catch(() => view.addNotice('公式のバッジ画像を取得できませんでした（自前の絵で表示します）'))
    }
    void loadCheermotes(roomId, callWorker)
      .then((loaded) => {
        cheermotes = loaded
      })
      .catch(() => view.addNotice('Cheermote（ビッツの絵）を取得できませんでした'))
  }

  connectChat(source.channel, {
    onEvent: (event) => {
      switch (event.type) {
        case 'message':
          view.add({
            ...event.message,
            // Cheermote を先に取り出してから、残った文字をエモートとして置き換える
            fragments: applyEmotes(
              applyCheermotes(event.message.fragments, cheermotes, event.message.bits),
              thirdPartyEmotes,
            ),
          })
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
          loadChannelAssets(event.roomId)
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
