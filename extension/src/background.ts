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
 * 映さないサイト（issue #165）: 映しているタブの中でページが移り始めたこと（webNavigation.onBeforeNavigate）と、URLが変わったこと
 * （tabs.onUpdated。history.pushState による画面遷移も含む）を controller.ts の handleNavigation へ渡す。一覧は Worker
 * （/api/admin/tab/blocked-hosts）が持ち、拡張は chrome.cookies で読んだセッションを Authorization ヘッダーで渡して読み書きする。
 * ボタンの右クリックに「このサイトを映さない」（登録済みなら「映す」）を出し、押されたら handleSiteMenuClick へ渡す。項目の名前は、
 * 前に出ているタブが変わるたびに覚えている一覧から決め直す（refreshSiteMenu）。拡張の設定ページ（options.ts）からの頼みは
 * handleSettingsRequest へ渡す。一覧は拡張を入れたときと Chrome を起動したときにも読んでおく（項目の名前を正しく出すため）。
 *
 * 映す範囲（issue #166）: ボタンの右クリックに「映す範囲を選ぶ」と「範囲を外す（タブ全体を映す）」を出す。選ぶときは、映しているタブへ
 * 範囲を選ぶ画面（area-picker.ts の pickArea）を chrome.scripting で差し込む（右クリックの項目を押すと、そのタブへの activeTab の
 * 許可が得られる）。選ばれた範囲はそのタブから知らせが届くので、送り主のタブを添えて handleAreaPicked へ渡す。
 *
 * 注意: うまくいかないときは黙って何もしないのではなくバッジ「!」で知らせ、理由はボタンの説明に出す。
 */
import { BLOCKED_HOSTS_PATH, isHostName, parseBlockedHosts } from '../../src/tab/blocked-hosts'
import { AREA_PICKER_TARGET, parseAreaPicked, pickArea } from './area-picker'
import { CONFIG_FILE, parseExtensionConfig, type ExtensionConfig } from './config'
import { OFFSCREEN_PAGE_FILE } from './built-files'
import {
  createSerialQueue,
  describeBadge,
  handleAreaPicked,
  handleClearAreaClick,
  handleClick,
  handleNavigation,
  handleOffscreenEvent,
  handlePickAreaClick,
  handleSettingsRequest,
  handleSiteMenuClick,
  isCaptureState,
  refreshSiteMenu,
  type ControllerApi,
} from './controller'
import { isRecord, reasonOf } from './guards'
import { SESSION_COOKIE_NAME } from './session-cookie'
import type { OffscreenCommandMessage, OffscreenReply } from './offscreen-command'
import { parseOffscreenEvent } from './offscreen-event'
import { parseSettingsRequest, type SettingsReply } from './settings-request'

/** 映しているタブの記録（CaptureState）を覚えておく chrome.storage.session の名前 */
const CAPTURING_KEY = 'capture'
/** 最後に読んだ映さないサイトの一覧を覚えておく chrome.storage.session の名前 */
const BLOCKED_HOSTS_KEY = 'blockedHosts'
/** ボタンの右クリックに出す「このサイトを映さない・映す」の識別子 */
const SITE_MENU_ID = 'block-site'
/** ボタンの右クリックに出す「映す範囲を選ぶ」の識別子 */
const PICK_AREA_MENU_ID = 'pick-area'
/** ボタンの右クリックに出す「範囲を外す」の識別子 */
const CLEAR_AREA_MENU_ID = 'clear-area'
/** 映しているタブの中のページ（iframe ではないもの）を表す webNavigation の frameId */
const MAIN_FRAME_ID = 0

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

/**
 * 配信者のセッションのクッキーを読む。offscreen document からの WebSocket にはクッキーが付かないので、値を読んで渡す。
 *
 * @throws クッキーが無い場合（Chrome で HDAD にログインしていない・拡張にサイトへのアクセスが許可されていない）
 */
const readSession = async (origin: string): Promise<string> => {
  const cookie = await chrome.cookies.get({ url: origin, name: SESSION_COOKIE_NAME })
  if (cookie === null || cookie.value === '') {
    throw new Error(
      `Chrome で HDAD（${origin}）にログインしていません。HDAD を開いてログインしてから押してください（ログインしているなら、chrome://extensions で拡張のサイトへのアクセスを許可してください）`,
    )
  }
  return cookie.value
}

/**
 * 映さないサイトの一覧の経路を、配信者のセッションで呼ぶ。
 *
 * 拡張からの通信にクッキーが付くかは当てにせず（offscreen document からの WebSocket には付かなかった）、
 * chrome.cookies で読んだセッションを Authorization ヘッダーで渡す（worker/tab-routes.ts）。
 *
 * @returns 呼んだあとの一覧
 * @throws 呼べない・Worker が失敗を返した・応答の形が違う場合
 */
const callBlockedHosts = async (init: RequestInit = {}, host?: string): Promise<string[]> => {
  const config = await loadConfig()
  const session = await readSession(config.origin)
  const path = host === undefined ? BLOCKED_HOSTS_PATH : `${BLOCKED_HOSTS_PATH}/${encodeURIComponent(host)}`
  const response = await fetch(`${config.origin}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = isRecord(body) && isRecord(body.error) ? body.error : {}
    throw new Error(typeof error.message === 'string' ? error.message : `HDAD が ${response.status} を返しました`)
  }
  return parseBlockedHosts(body)
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

/**
 * offscreen document に、映しているあいだの頼み（送るのを止める・送り直す）をする。
 *
 * @throws offscreen document が応じられなかった場合
 */
const commandWhileCapturing = async (type: 'pause' | 'resume'): Promise<void> => {
  const reply = await command({ target: 'offscreen', type })
  if (!reply.ok) throw new Error(reply.message)
}

const api: ControllerApi = {
  capturing: async () => {
    // offscreen document が無ければ、覚えていても映していない（拡張を読み込み直したときなど）
    if (!(await hasOffscreen())) return null
    const stored: unknown = (await chrome.storage.session.get(CAPTURING_KEY))[CAPTURING_KEY]
    if (stored === undefined) return null
    if (!isCaptureState(stored)) throw new Error('映しているタブの記録の形が想定と違います。拡張を読み込み直してください')
    return stored
  },
  remember: async (state) => {
    if (state === null) await chrome.storage.session.remove(CAPTURING_KEY)
    else await chrome.storage.session.set({ [CAPTURING_KEY]: state })
  },
  loadBlockedHosts: () => callBlockedHosts(),
  addBlockedHost: (host) => callBlockedHosts({ method: 'POST', body: JSON.stringify({ host }) }),
  removeBlockedHost: (host) => callBlockedHosts({ method: 'DELETE' }, host),
  knownBlockedHosts: async () => {
    const stored: unknown = (await chrome.storage.session.get(BLOCKED_HOSTS_KEY))[BLOCKED_HOSTS_KEY]
    if (stored === undefined) return null
    if (!Array.isArray(stored) || !stored.every(isHostName)) throw new Error('覚えている映さないサイトの一覧の形が想定と違います。拡張を読み込み直してください')
    return stored
  },
  rememberBlockedHosts: async (hosts) => {
    await chrome.storage.session.set({ [BLOCKED_HOSTS_KEY]: hosts })
  },
  activeTab: async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] ?? null,
  getMediaStreamId: (targetTabId) => chrome.tabCapture.getMediaStreamId({ targetTabId }),
  startCapture: async (streamId) => {
    const config = await loadConfig()
    const session = await readSession(config.origin)
    await ensureOffscreen()
    const reply = await command({ target: 'offscreen', type: 'start', streamId, origin: config.origin, session })
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
  pauseCapture: () => commandWhileCapturing('pause'),
  resumeCapture: () => commandWhileCapturing('resume'),
  pickArea: async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId }, func: pickArea, args: [AREA_PICKER_TARGET] })
  },
  setCrop: async (crop) => {
    const reply = await command({ target: 'offscreen', type: 'crop', crop })
    if (!reply.ok) throw new Error(reply.message)
  },
  show: async (state) => {
    const view = describeBadge(state)
    if (view.color !== null) await chrome.action.setBadgeBackgroundColor({ color: view.color })
    await chrome.action.setBadgeText({ text: view.text })
    await chrome.action.setTitle({ title: view.title })
  },
  showSiteMenu: async (menu) => {
    await chrome.contextMenus.update(SITE_MENU_ID, { title: menu.title, enabled: menu.enabled })
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

/**
 * 映さないサイトの一覧を読んでおき、右クリックの項目の名前を決める。
 *
 * 読めなくても（ログインしていないなど）ここでは知らせない。項目は「切り替える」の名前のまま押せ、押したときに読み直して理由を出すため。
 */
const preloadBlockedHosts = async (): Promise<void> => {
  try {
    await api.rememberBlockedHosts(await api.loadBlockedHosts())
  } catch (error) {
    console.error('映さないサイトの一覧を前もって読めませんでした', error)
  }
  await refreshSiteMenu(api)
}

chrome.runtime.onInstalled.addListener(() => {
  // 右クリックの項目は拡張を入れた・更新したときに作る（作り直すと Chrome が重複の失敗を返すので、起動のたびには作らない）
  chrome.contextMenus.create({ id: SITE_MENU_ID, title: 'このサイトを映さない', contexts: ['action'] })
  chrome.contextMenus.create({ id: PICK_AREA_MENU_ID, title: '映す範囲を選ぶ', contexts: ['action'] })
  chrome.contextMenus.create({ id: CLEAR_AREA_MENU_ID, title: '範囲を外す（タブ全体を映す）', contexts: ['action'] })
  void enqueue(preloadBlockedHosts)
})

// chrome.storage.session は Chrome を閉じると消えるので、起動したときに読み直す
chrome.runtime.onStartup.addListener(() => {
  void enqueue(preloadBlockedHosts)
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  switch (info.menuItemId) {
    case SITE_MENU_ID:
      void enqueue(() => handleSiteMenuClick(tab ?? {}, api))
      return
    case PICK_AREA_MENU_ID:
      void enqueue(() => handlePickAreaClick(tab ?? {}, api))
      return
    case CLEAR_AREA_MENU_ID:
      void enqueue(() => handleClearAreaClick(api))
      return
  }
})

// 前に出ているタブが変わったら、右クリックの項目の名前を合わせる
chrome.tabs.onActivated.addListener(() => {
  void enqueue(() => refreshSiteMenu(api))
})
chrome.windows.onFocusChanged.addListener(() => {
  void enqueue(() => refreshSiteMenu(api))
})

// 映さないサイトへ移り始めたら、新しいページが描かれる前に止める（iframe の中の移動は映っているページを変えないので見ない）
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== MAIN_FRAME_ID) return
  void enqueue(() => handleNavigation({ tabId: details.tabId, url: details.url, committed: false }, api))
})

// URLが変わった（新しいページの表示・history.pushState による画面遷移・先読みしたページへの切り替え）
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url === undefined) return
  const url = changeInfo.url
  void enqueue(async () => {
    await handleNavigation({ tabId, url, committed: true }, api)
    await refreshSiteMenu(api)
  })
})

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (reply: SettingsReply) => void) => {
  let picked
  try {
    picked = parseAreaPicked(message)
  } catch (error) {
    report('範囲を選ぶ画面からの知らせを読み取れませんでした', error)
    return false
  }
  if (picked !== null) {
    // どのタブで選ばれたかは知らせの中身ではなく、Chrome が添える送り主から取る
    const tabId = sender.tab?.id
    if (tabId === undefined) {
      report('範囲を選ぶ画面からの知らせを読み取れませんでした', new Error('送り主のタブが分かりません'))
      return false
    }
    void enqueue(() => handleAreaPicked({ tabId, crop: picked.crop }, api))
    return false
  }

  let request
  try {
    request = parseSettingsRequest(message)
  } catch (error) {
    sendResponse({ ok: false, message: reasonOf(error) })
    return false
  }
  if (request !== null) {
    // 設定ページからの頼みも、押下や知らせと同じ順番に並べる（映しているタブの記録を読み書きするため）
    void enqueue(async () => {
      try {
        sendResponse(await handleSettingsRequest(request, api))
      } catch (error) {
        // 返事をしないと設定ページが待ち続けるので、思わぬ失敗でも理由を返してから知らせる
        sendResponse({ ok: false, message: reasonOf(error) })
        throw error
      }
    })
    // 返事を非同期で送るので true を返す（Chrome の決まり）
    return true
  }
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
