/**
 * 拡張のサービスワーカー
 *
 * ツールバーのボタン（ショートカットの既定は Alt+Shift+T）が押されたら、そのタブを HDAD の送り手のページ（/tab/）へ渡す。
 * 手順そのものは hand-over.ts にあり、ここは Chrome の API と、同梱の設定（config.json。ダウンロードのときに Worker が
 * 書き込む。config.ts）に書かれた信頼する置き場所を渡すだけにする。
 *
 * ショートカットは manifest.json の _execute_action に割り当て、ボタンを押したのと同じ扱いにする。
 * ボタンかショートカットで呼ばれると、そのタブを取り込む許可（activeTab と同じ扱い）が得られ、getMediaStreamId を呼べる。
 *
 * 注意: 送り手のページが見つからないときなどは、黙って何もしないのではなくバッジ「!」で知らせ、理由はボタンの説明に出す。
 */
import { CONFIG_FILE, parseExtensionConfig, type ExtensionConfig } from './config'
import { handOverTab, type ExtensionApi } from './hand-over'

/** 知らせが無いときのボタンの説明（manifest.json の default_title と同じ） */
const DEFAULT_TITLE = 'このタブを配信に映す（HDAD）'
/** 知らせがあるときのバッジ */
const PROBLEM_BADGE = '!'
const PROBLEM_COLOR = '#d93025'

const api: ExtensionApi = {
  listTabs: () => chrome.tabs.query({}),
  getMediaStreamId: (targetTabId, consumerTabId) => chrome.tabCapture.getMediaStreamId({ targetTabId, consumerTabId }),
  updateTabUrl: async (tabId, url) => {
    await chrome.tabs.update(tabId, { url })
  },
  showProblem: async (message) => {
    await chrome.action.setBadgeBackgroundColor({ color: PROBLEM_COLOR })
    await chrome.action.setBadgeText({ text: message === null ? '' : PROBLEM_BADGE })
    await chrome.action.setTitle({ title: message ?? DEFAULT_TITLE })
  },
}

/**
 * 同梱の設定を読む。押されるたびに読む（読むのは拡張の中のファイルなので速く、持ち回る状態を作らずに済む）。
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

chrome.action.onClicked.addListener((tab) => {
  loadConfig()
    .then((config) => handOverTab(tab, api, config.trustedOrigins))
    .catch((error: unknown) => {
      // 設定を読めない・Chrome の API が失敗した。原因を追えるよう記録し、バッジでも知らせる
      console.error('タブを送り手のページへ渡せませんでした', error)
      void api.showProblem(`タブを渡せませんでした: ${error instanceof Error ? error.message : String(error)}`)
    })
})
