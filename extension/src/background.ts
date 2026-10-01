/**
 * 拡張のサービスワーカー
 *
 * ツールバーのボタン（ショートカットの既定は Alt+Shift+T）が押されたら、そのタブを映す。映しているタブで押されたら止める。
 * 手順そのものは controller.ts にあり、ここは Chrome の API をつなぐだけにする。
 *
 * 取り込みと送信は offscreen document（offscreen.html は zip を作るときに Worker が書く。中身は offscreen.ts）が受け持つ。サービスワーカーは眠ると変数も
 * 映像も失うので、映像を持ち続けられる画面が要るため（chrome.offscreen の USER_MEDIA）。映しているタブは
 * chrome.storage.session に覚える。
 *
 * ショートカットは manifest.json の _execute_action に割り当て、ボタンを押したのと同じ扱いにする。
 * ボタンかショートカットで呼ばれると、そのタブを取り込む許可（activeTab と同じ扱い）が得られ、getMediaStreamId を呼べる。
 *
 * 注意: うまくいかないときは黙って何もしないのではなくバッジ「!」で知らせ、理由はボタンの説明に出す。
 */
import { CONFIG_FILE, parseExtensionConfig, type ExtensionConfig } from './config'
import { OFFSCREEN_PAGE_FILE } from './built-files'
import { createSerialQueue, describeBadge, handleClick, handleOffscreenEvent, type ControllerApi } from './controller'
import { reasonOf } from './guards'
import type { OffscreenCommandMessage, OffscreenReply } from './offscreen-command'
import { parseOffscreenEvent } from './offscreen-event'

/** 映しているタブを覚えておく chrome.storage.session の名前 */
const CAPTURING_KEY = 'capturingTabId'

/**
 * 同梱の設定を読む。映し始めるたびに読む（読むのは拡張の中のファイルなので速く、持ち回る状態を作らずに済む）。
 *
 * @throws 設定が無い・読めない場合（アプリからダウンロードせずに読み込んだときなど）
 */
const loadConfig = async (): Promise<ExtensionConfig> => {
  let value: unknown
  try {
    value = await (await fetch(chrome.runtime.getURL(CONFIG_FILE))).json()
  } catch {
    throw new Error(`拡張の設定（${CONFIG_FILE}）がありません。HDAD の「タブの映像」のページ（/tab/）から拡張をダウンロードし直してください`)
  }
  return parseExtensionConfig(value)
}

const hasOffscreen = async (): Promise<boolean> =>
  (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length > 0

const ensureOffscreen = async (): Promise<void> => {
  if (await hasOffscreen()) return
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PAGE_FILE,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: '映すタブの映像と音を取り込み、HDAD の合成ページへ送り続けるため',
  })
}

const isReply = (value: unknown): value is OffscreenReply =>
  typeof value === 'object' && value !== null && 'ok' in value && (value.ok === true || ('message' in value && typeof value.message === 'string'))

/**
 * offscreen document に頼み、返事を待つ。
 *
 * @throws 返事の形が違う場合（拡張の版が食い違っている）
 */
const command = async (message: OffscreenCommandMessage): Promise<OffscreenReply> => {
  const reply: unknown = await chrome.runtime.sendMessage(message)
  if (!isReply(reply)) throw new Error('offscreen document からの返事の形が想定と違います')
  return reply
}

const api: ControllerApi = {
  capturingTabId: async () => {
    // offscreen document が無ければ、覚えていても映していない（拡張を読み込み直したときなど）
    if (!(await hasOffscreen())) return null
    const stored: unknown = (await chrome.storage.session.get(CAPTURING_KEY))[CAPTURING_KEY]
    return typeof stored === 'number' ? stored : null
  },
  remember: async (tabId) => {
    if (tabId === null) await chrome.storage.session.remove(CAPTURING_KEY)
    else await chrome.storage.session.set({ [CAPTURING_KEY]: tabId })
  },
  getMediaStreamId: (targetTabId) => chrome.tabCapture.getMediaStreamId({ targetTabId }),
  startCapture: async (streamId) => {
    const config = await loadConfig()
    await ensureOffscreen()
    const reply = await command({ target: 'offscreen', type: 'start', streamId, origin: config.origin })
    if (!reply.ok) throw new Error(reply.message)
  },
  stopCapture: async () => {
    if (!(await hasOffscreen())) return
    try {
      // 合成ページへ「映すのをやめた」を送り終えてから閉じる
      await command({ target: 'offscreen', type: 'stop' })
    } finally {
      // offscreen document が応えなくても閉じる（残すと、タブの映像と中継先への接続が残り続ける）
      await chrome.offscreen.closeDocument()
    }
  },
  show: async (state) => {
    const view = describeBadge(state)
    if (view.color !== null) await chrome.action.setBadgeBackgroundColor({ color: view.color })
    await chrome.action.setBadgeText({ text: view.text })
    await chrome.action.setTitle({ title: view.title })
  },
}

/** 思わぬ失敗。原因を追えるよう記録し、バッジでも知らせる */
const report = (what: string, error: unknown): void => {
  console.error(what, error)
  api.show({ kind: 'problem', message: `${what}: ${reasonOf(error)}` }).catch((showError: unknown) => {
    // バッジも変えられない（拡張を読み込み直している途中など）。記録だけは残す
    console.error('ボタンに失敗を表示できませんでした', showError)
  })
}

/** 押下と知らせを1つずつ順に処理する（controller.ts の createSerialQueue） */
const enqueue = createSerialQueue((error) => report('タブの映像の操作に失敗しました', error))

chrome.action.onClicked.addListener((tab) => {
  void enqueue(() => handleClick(tab, api))
})

chrome.runtime.onMessage.addListener((message: unknown) => {
  try {
    const event = parseOffscreenEvent(message)
    // 映し始めの途中に届いた知らせは、押下の処理（映しているタブの記録）が終わってから表示に反映する
    if (event !== null) void enqueue(() => handleOffscreenEvent(event, api))
  } catch (error) {
    report('offscreen document からの知らせを読み取れませんでした', error)
  }
  // 返事は送らない（offscreen document は知らせるだけで、返事を待たない）
  return false
})
