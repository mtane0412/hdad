/**
 * 拡張のサービスワーカー
 *
 * ツールバーのボタン（ショートカットの既定は Alt+Shift+T）が押されたら、そのタブを HDAD の送り手のページ（/tab/）へ渡す。
 * 手順そのものは hand-over.ts にあり、ここは Chrome の API をつないで渡すだけにする。
 *
 * ショートカットは manifest.json の _execute_action に割り当て、ボタンを押したのと同じ扱いにする。
 * ボタンかショートカットで呼ばれると、そのタブを取り込む許可（activeTab と同じ扱い）が得られ、getMediaStreamId を呼べる。
 *
 * 注意: 送り手のページが見つからないときなどは、黙って何もしないのではなくバッジ「!」で知らせ、理由はボタンの説明に出す。
 */
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

chrome.action.onClicked.addListener((tab) => {
  handOverTab(tab, api).catch((error: unknown) => {
    // 手順の途中で Chrome の API が失敗した。原因を追えるよう記録し、バッジでも知らせる
    console.error('タブを送り手のページへ渡せませんでした', error)
    void api.showProblem(`タブを渡せませんでした: ${error instanceof Error ? error.message : String(error)}`)
  })
})
