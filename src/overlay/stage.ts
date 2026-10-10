/**
 * 合成オーバーレイ（overlay/stage/index.html）のエントリスクリプト
 *
 * OBSのブラウザソースはその数だけ Chromium のレンダラを立ち上げるため、素材ごとにページを分けると
 * 配信中のメモリを食う。そこで素材を1枚のページに重ね、ブラウザソースは「オーバーレイ」ごとに1つだけ置く（issue #101・#103）。どのオーバーレイにどの素材をどこへ置くかは Worker が持つ構成（KVの
 * overlay-layout）で決まるので、OBSに貼るURLは ?key=（オーバーレイ用キー）と ?overlay=（オーバーレイの名前）だけで、
 * 一度貼ったら変わらない。
 *
 * オーバーレイを分けるのは、アバターやゲーム画面というWebでないソースが間に挟まり、Web側の素材をその前と後ろの
 * 両方に置きたいためである。構成の読み出しは api.ts、オーバーレイの絞り込みと箱の位置は layout.ts、
 * ポーリングの束ね方は poll.ts にあり、ここはそれらをつないでDOMとWebSocketを扱う。
 *
 * まとめることで減るものを、次の3つの決まりで守る。
 * - 素材ごとに canvas を1枚持ち、1枚の全画面 canvas へ合成しない（まとめたのに重くならないため。
 *   小さく置いた時計が全画面ぶんの描画面積を持ってしまう）
 * - requestAnimationFrame はオーバーレイで1本にし、そのループの中で各素材の描画を順に呼ぶ
 * - 同じオーバーレイの素材は接続を共有する（匿名IRCは1本、チャンネル名とバッジ・Cheermote の取得も1回、
 *   ポーリングは1つのタイマー）
 *
 * ?demo=true のときは管理画面（/overlay/）のプレビューとして開かれている（issue #106）。このときは映す構成を
 * Worker から読まずに親の窓から受け取り（preview.ts）、素材の中身はすべてサンプルにして Twitch にも Worker にも
 * つながない。編集中の構成をそのまま映せるようにするためで、保存はその時点で配信画面へ反映されるため
 * 「保存してから確かめる」ではプレビューの意味が無くなる。つながないので、配信中のオーバーレイに加えて
 * 匿名IRC・アラートのWebSocket・ポーリングがもう1組動くこともない。
 *
 * 注意: 1つの素材の失敗で、同じオーバーレイのほかの素材は動かし続ける（issue #101 で決めた、Fail-Fast に
 * 意識して設けた例外）。理由は「配信中に片方が壊れたときの被害を、配信画面の全損から1素材の欠落に
 * 留めるため」で、失敗はその素材の箱の中だけに表示する。
 * 注意: OBSに載せるページの約束どおり、React もログインも持ち込まない。
 */
import type { Alert } from '../alerts/alert'
import { demoAlerts } from '../alerts/demo'
import { EMPTY_QUEUE, advance, enqueue } from '../alerts/queue'
import { connectAlerts } from '../alerts/socket'
import { NO_CAPTIONS, applyCaptionMessage, visibleCaptions, type CaptionState } from '../caption/captions'
import { demoCaptionMessages } from '../caption/demo'
import type { CaptionMessage } from '../caption/message'
import { connectCaptionViewer } from '../caption/socket'
import { createCaptionView } from '../caption/view'
import { createDrawOverlayApi } from '../draw/api'
import { demoStrokes } from '../draw/demo'
import { connectDrawViewer } from '../draw/socket'
import { NO_STROKES, applyDrawMessage, type Strokes } from '../draw/strokes'
import { drawStrokes } from '../draw/view'
import { createAlertView } from '../alerts/view'
import { BGM_SOCKET_HINT, BGM_SOCKET_PATH, createBgmOverlayApi, parseBgmNowPlaying, type BgmNowPlaying } from '../bgm/api'
import { createBgmCreditView } from '../bgm/credit-view'
import { demoBgmTracks } from '../bgm/demo'
import { badgeKey, loadBadges, type BadgeMap } from '../chat/badges'
import { loadChannel } from '../chat/channel'
import { applyCheermotes, loadCheermotes, type CheermoteMap } from '../chat/cheermotes'
import { connectChat, type ChatConnectionHandlers } from '../chat/connection'
import { sourceOf } from '../chat/definition'
import { startDemo } from '../chat/demo'
import { applyEmotes, fetchJson, loadThirdPartyEmotes, type EmoteMap } from '../chat/emotes'
import type { BadgeRef, ChatMessage } from '../chat/message'
import { chats } from '../chat/registry'
import { createChatView } from '../chat/view'
import { clocks } from '../clock/registry'
import { clearError, findDefinition, showError, startCanvasLayer, startCanvasSurface, type DrawFrame } from '../core/mount'
import { ParamError, parseParams, type ParamSchema } from '../core/params'
import { connectSocket, socketUrl } from '../core/socket'
import { createFocusOverlayApi } from '../focus/api'
import { demoFocused } from '../focus/demo'
import { NO_FOCUS, withRemoval, withTarget, type FocusState } from '../focus/focused'
import { createFocusView } from '../focus/view'
import { createSideSuperApi } from '../side-super/api'
import { demoSideSupers } from '../side-super/demo'
import { sideSuperParamSchema } from '../side-super/params'
import { createSideSuperView } from '../side-super/view'
import { startSpeechVoice, type SpeechVoice } from '../speech/voice'
import { layoutCrop, type Rect, type TabCrop } from '../tab/crop'
import { openReceiverPeer } from '../tab/peer'
import { createTabReceiver } from '../tab/receiver'
import { connectTabViewer } from '../tab/socket'
import { KANJI_QUIZ_SOCKET_HINT, KANJI_QUIZ_SOCKET_PATH, createKanjiQuizApi } from '../kanji-quiz/api'
import { parseKanjiQuizMessage, type KanjiQuizCall } from '../kanji-quiz/call'
import { DEMO_KANJI_QUIZ_CALLS, DEMO_KANJI_QUIZ_INTERVAL_MS } from '../kanji-quiz/demo'
import { acceptsAnswerAt, kanjiQuizEndOf, kanjiQuizSceneAt, kanjiQuizStopBannerAt, type KanjiQuizStop } from '../kanji-quiz/scene'
import { drawKanjiQuiz } from '../kanji-quiz/view'
import { POMODORO_SOCKET_HINT, POMODORO_SOCKET_PATH, createPomodoroOverlayApi } from '../pomodoro/api'
import { demoPomodoroScenes, demoTimerOf } from '../pomodoro/demo'
import { parsePomodoroSnapshot, type PomodoroTimer } from '../pomodoro/phase'
import { createPomodoroView } from '../pomodoro/view'
import { OPINION_SOCKET_HINT, OPINION_SOCKET_PATH, createOpinionOverlayApi } from '../opinions/api'
import { demoOpinionBoards } from '../opinions/demo'
import { parseOpinionBoardMessage, type OpinionBoard } from '../opinions/entry'
import { createOpinionView } from '../opinions/view'
import { TASK_DESK_SOCKET_HINT, TASK_DESK_SOCKET_PATH, createTaskDeskApi } from '../task-desk/api'
import { demoTaskDeskScenes } from '../task-desk/demo'
import { parseTaskDeskSnapshot, type TaskDeskSnapshot, type TaskDeskWorkTime } from '../task-desk/entry'
import { createTaskDeskView } from '../task-desk/view'
import { TEXT_SOCKET_HINT, TEXT_SOCKET_PATH, createTextOverlayApi } from '../text/api'
import { demoTexts } from '../text/demo'
import { parseTextsMessage, textToShow, type TextEntry } from '../text/entry'
import { textParamSchema } from '../text/params'
import { createTextView } from '../text/view'
import { TOWN_TOUR_SOCKET_HINT, TOWN_TOUR_SOCKET_PATH, createTownTourApi } from '../town-tour/api'
import { bgmDuckHoldOf } from '../town-tour/bgm-duck'
import { DEMO_INTRO_DELAY_MS, DEMO_TOWN_TOUR_INTERVAL_MS, demoTownTourCall, demoTownTourIntro } from '../town-tour/demo'
import { BGM_START_CUE_ID, dueSoundCues } from '../town-tour/sound-cues'
import { loadTownTourImage } from '../town-tour/image-loader'
import { narrationTextsOf, type Narration, type NarrationClip } from '../town-tour/narration'
import { loadNarrationClip, releaseNarration } from '../town-tour/narration-loader'
import { createTownTourSoundPlayer } from '../town-tour/sound-player'
import { QUIZ_MS, quizClueOf, quizHintsOf } from '../town-tour/quiz'
import { conquestOf } from '../town-tour/conquest'
import { sceneAt, visitRecordAtOf, type Playback } from '../town-tour/timeline'
import { decodeTownBorders, decodeTownShapes, type TownBorders } from '../town-tour/topo'
import { parseTownTourMessage, tourLinesOf, type TownTourCall, type TownTourIntro } from '../town-tour/tour'
import { createTownTourRenderer, type TownTourRenderer } from '../town-tour/view'
import { TWISTER_SOCKET_HINT, TWISTER_SOCKET_PATH } from '../twister/api'
import { twisterBgmPlanOf } from '../twister/bgm'
import { createTwisterBgmPlayer } from '../twister/bgm-player'
import { parseTwisterCall, type TwisterCall } from '../twister/call'
import { DEMO_TWISTER_CALLS, DEMO_TWISTER_INTERVAL_MS } from '../twister/demo'
import { loadFaceImage } from '../twister/face-loader'
import { createGame, gameSceneAt, type Game } from '../twister/game'
import { createTwisterRenderer } from '../twister/view'
import { backgrounds } from '../wallpaper/registry'
import { createWipeOverlayApi } from '../wipe/api'
import { wipeCommentOf } from '../wipe/comment'
import { demoWipeComments } from '../wipe/demo'
import { createWipeRunner, waitOrAbort, type WipeRunner } from '../wipe/runner'
import { createWipeView } from '../wipe/view'
import { WORK_LOG_SOCKET_HINT, WORK_LOG_SOCKET_PATH, createWorkLogApi } from '../work-log/api'
import { demoWorkLogScenes } from '../work-log/demo'
import { WORK_LOG_LIMIT, mergeEntries, parseWorkLogEntry, type WorkLogEntry } from '../work-log/entry'
import { createWorkLogView } from '../work-log/view'
import { createOverlayLayoutApi } from './api'
import { itemsInOverlay, overlayNamesOf, rectStyle, type ItemKind, type Overlay, type OverlayItem } from './layout'
import { dueTasks, pollTickMs, type PollInterval } from './poll'
import { previewReadyMessage, readPreviewLayout } from './preview'

/** ページ全体の失敗（構成が読めない・オーバーレイに素材が無い）でエラー表示に使う呼び名 */
const NOUN = 'オーバーレイ'

/** 素材の失敗を表示するときに素材を指す呼び名 */
const NOUNS: Readonly<Record<ItemKind, string>> = {
  wallpaper: '背景',
  clock: '時計',
  chat: 'チャットボックス',
  alerts: 'アラート',
  sideSuper: 'サイドスーパー',
  focus: '注目コメント',
  draw: '手書き',
  bgm: '再生中の曲',
  tab: 'タブの映像',
  caption: '字幕',
  workLog: '作業ログ',
  taskDesk: '作業机',
  pomodoro: 'ポモドーロ',
  townTour: '市町村紹介',
  twister: 'ツイスター',
  wipe: 'ワイプ',
  text: 'テキスト',
  kanjiQuiz: '漢字クイズ',
  opinions: '意見ボード',
}

/** サイドスーパーの文言を読みに行く間隔（ミリ秒）。文言は cron が5分おきに作るので、30秒あれば十分に追いつく */
const SIDE_SUPER_INTERVAL_MS = 30000
/**
 * 作業ログを読み直す間隔（ミリ秒）。増えた1行は押し出しで届くので、読み直しは取りこぼしと配信の切り替わりを拾うためだけにある。
 * 配信の切り替わり（前の配信のログを消す）を拾うのに、cron の間隔（5分）より細かくする意味はない
 */
const WORK_LOG_INTERVAL_MS = 300000
/**
 * 作業机を読み直す間隔（ミリ秒）。変わった作業机は押し出しで届くので、読み直しは取りこぼしと配信の切り替わり
 * （前の配信の宣言を片付ける）を拾うためだけにある。作業ログと同じ理由で、cron の間隔（5分）に合わせる
 */
const TASK_DESK_INTERVAL_MS = 300000
/**
 * ポモドーロのタイマーを読み直す間隔（ミリ秒）。始めた・止めたなどは押し出しで届き、区切りは始めた時刻から合成ページが計算するので、
 * 読み直しは取りこぼしと、配信が終わって Worker がタイマーを止めたこと（押し出しが届かなかったとき）を拾うためだけにある。作業机と同じく cron の間隔に合わせる
 */
const POMODORO_INTERVAL_MS = 300000
/**
 * テキストを読み直す間隔（ミリ秒）。書き換えは押し出しで届くので、読み直しは取りこぼしを拾うためだけにある。作業机と同じく cron の間隔に合わせる
 */
const TEXT_INTERVAL_MS = 300000
/**
 * 意見ボードを読み直す間隔（ミリ秒）。変わった意見ボードは押し出しで届くので、読み直しは取りこぼしを拾うためだけにある。作業机と同じく cron の間隔に合わせる
 */
const OPINIONS_INTERVAL_MS = 300000
/** 取り上げている注目コメントを読みに行く間隔（ミリ秒）。配信中に選び直したとき、待たされすぎない長さにする */
const FOCUS_INTERVAL_MS = 10000
/** 市町村紹介の音を鳴らす時刻を迎えたか確かめる間隔（ミリ秒）。場面の切り替わりとずれて聞こえない短さにする */
const TOWN_TOUR_SOUND_TICK_MS = 50

/** プレビューでサンプルのアラートを流す間隔（ミリ秒）。アラート1件の再生が終わるだけの間を置く */
const DEMO_ALERT_INTERVAL_MS = 9000
/** プレビューでサンプルの文言・注目コメントを切り替える間隔（ミリ秒）。読み終わるだけの間を置く */
const DEMO_SAMPLE_INTERVAL_MS = 6000
/** プレビューでサンプルの字幕を1通ずつ流す間隔（ミリ秒）。話している途中の文が伸びていく様子が分かる速さにする */
const DEMO_CAPTION_INTERVAL_MS = 1200
/** プレビューが親の窓から構成を受け取るまで待つ上限（ミリ秒）。届かなければ理由を画面に出す */
const PREVIEW_WAIT_MS = 5000

const schema = {
  key: {
    type: 'string',
    default: '',
    // Workerが発行するキー（worker/secret.ts の randomToken）は、URLにそのまま載せられる文字だけでできている
    pattern: /^[A-Za-z0-9_-]{32,}$/,
    example: '管理用API（/api/me）の overlayKey の値',
    description: 'オーバーレイ用キー（必須）',
  },
  overlay: {
    type: 'string',
    default: 'front',
    // オーバーレイの名前の書式は worker/overlay-layout.ts の NAME_PATTERN と合わせる
    pattern: /^[a-z0-9-]{1,20}$/,
    example: 'back または front',
    description: '描くオーバーレイの名前（このオーバーレイに積んだ素材だけを重ねる）',
  },
  demo: {
    type: 'boolean',
    default: false,
    description: '管理画面のプレビューとして描く（構成は親の窓から受け取り、素材の中身はすべてサンプルにする）',
  },
} as const satisfies ParamSchema

// fetch をそのまま渡すと this が外れて Illegal invocation になるブラウザがあるので、包んで渡す
const callWorker: typeof fetch = (input, init) => fetch(input, init)

/** 描画を続ける素材1つ。描画中に投げたら、その箱にだけ失敗を出して一覧から外す */
interface DrawingItem {
  readonly box: HTMLElement
  readonly noun: string
  readonly draw: DrawFrame
}

/** 読みに行くもの1つ（オーバーレイで1本のタイマーが回す） */
interface PollTask extends PollInterval {
  run(): void
}

/**
 * 同じオーバーレイのチャットの受け取りをまとめる。
 *
 * チャットボックスと注目コメントを同じオーバーレイに置いても、匿名IRCの接続・チャンネル名の取得・公式バッジと
 * Cheermote の取得はそれぞれ1回で済ませ、届いた発言を登録された相手へ配る。
 */
const createChatHub = () => {
  const handlers: ChatConnectionHandlers[] = []
  /** 公式バッジ画像が必要か（チャットボックスの badges パラメータが1つでも true なら読み込む） */
  let needsBadges = false
  /** サードパーティエモートが必要か */
  let needsThirdParty = false
  let officialBadges: BadgeMap = new Map()
  let cheermotes: CheermoteMap = new Map()
  let thirdPartyEmotes: EmoteMap = new Map()
  let loadedRoomId: string | undefined

  /** 登録された相手に、システムからのお知らせとして1行伝える（出す場所を持たない素材は捨てる） */
  const notify = (text: string): void => {
    for (const handler of handlers) handler.onEvent({ type: 'notice', text })
  }

  /**
   * サードパーティエモートを読み込む。
   * ROOMSTATE は再接続のたびに届くので、同じチャンネルでは1回だけにする。
   */
  const loadEmotes = (roomId: string): void => {
    if (!needsThirdParty || roomId === loadedRoomId) return
    loadedRoomId = roomId
    void loadThirdPartyEmotes(roomId, fetchJson).then(({ emotes, failures }) => {
      thirdPartyEmotes = emotes
      if (failures.length > 0) notify(`${failures.join('・')} のエモートを取得できませんでした`)
    })
  }

  return {
    /** この素材が要るものを伝える（要らないものはWorkerにも取りに行かない） */
    require({ badges, thirdparty }: { badges: boolean; thirdparty: boolean }): void {
      needsBadges = needsBadges || badges
      needsThirdParty = needsThirdParty || thirdparty
    },

    /** 発言の受け取りを登録する */
    listen(handler: ChatConnectionHandlers): void {
      handlers.push(handler)
    },

    /** 公式のバッジ画像を引く（まだ届いていなければ undefined。自前の絵で表示される） */
    lookupBadge: (badge: BadgeRef) => officialBadges.get(badgeKey(badge)),

    /**
     * 届いた発言に絵を当てる。
     *
     * Cheermote を先に取り出してから、残った文字をエモートとして置き換える（先にエモートを当てると、
     * Cheermote の文字が絵に置き換わって取り出せなくなる）。サードパーティエモートは、それを要求した素材にだけ当てる。
     */
    decorate(message: ChatMessage, thirdparty: boolean): ChatMessage {
      const fragments = applyCheermotes(message.fragments, cheermotes, message.bits)
      return { ...message, fragments: thirdparty ? applyEmotes(fragments, thirdPartyEmotes) : fragments }
    },

    /**
     * 接続先を取得してつなぐ。登録がすべて済んだあとに1回だけ呼ぶ。
     *
     * @throws チャンネル名を取得できなかった場合（呼び出し側が、チャットを使う素材の箱に出す）
     */
    async start(): Promise<void> {
      // 接続先はこのWorkerが扱う配信者のチャンネル。取得できなければチャットは始められない
      const channel = await loadChannel(callWorker)

      // 対象が決まっているので ROOMSTATE を待たずに読み込む。取得できなくても表示は止めない
      if (needsBadges) {
        void loadBadges(callWorker)
          .then((badges) => {
            officialBadges = badges
          })
          .catch(() => notify('公式のバッジ画像を取得できませんでした（自前の絵で表示します）'))
      }
      void loadCheermotes(callWorker)
        .then((loaded) => {
          cheermotes = loaded
        })
        .catch(() => notify('Cheermote（ビッツの絵）を取得できませんでした'))

      connectChat(channel.login, {
        onEvent: (event) => {
          if (event.type === 'room') loadEmotes(event.roomId)
          for (const handler of handlers) handler.onEvent(event)
        },
        onStatus: (status) => {
          for (const handler of handlers) handler.onStatus(status)
        },
      })
    },
  }
}

type ChatHub = ReturnType<typeof createChatHub>

/**
 * 素材を起動するときの、オーバーレイで共通の文脈。
 *
 * demo が真なら管理画面のプレビューなので、素材の中身はすべてサンプルにして外へはつながない
 * （オーバーレイ用キーも持たない）。
 */
interface MountContext {
  readonly key: string
  readonly demo: boolean
  readonly hub: ChatHub
}

/**
 * プレビューでサンプルを一定間隔で順に流す（一巡したらまた先頭から）。
 *
 * アラート・サイドスーパー・注目コメントの3種類で、同じ流し方を共有する。
 */
const startSampleCycle = <T,>(samples: readonly T[], intervalMs: number, show: (sample: T) => void): void => {
  let index = 0
  const next = (): void => {
    const sample = samples[index % samples.length]
    index += 1
    if (sample) show(sample)
  }
  next()
  window.setInterval(next, intervalMs)
}

/** 素材を起動した結果。描くもの・読みに行くものがあれば返す */
interface MountedItem {
  readonly draw?: DrawFrame
  readonly task?: PollTask
  /** チャットの受け取りを使うか（つなげなかったときに、この箱へ失敗を出す） */
  readonly usesChat?: boolean
}

/** 壁紙・時計。箱の中に canvas を1枚置き、1フレームぶんの描画を受け取る */
const mountCanvasMaterial = (box: HTMLElement, item: OverlayItem): MountedItem => {
  const definitions = item.kind === 'wallpaper' ? backgrounds : clocks
  const definition = findDefinition(definitions, item.id, NOUNS[item.kind])
  const canvas = document.createElement('canvas')
  // 何を描いている canvas かを属性に残す（開発者ツールで追えるようにする）
  canvas.dataset[item.kind === 'wallpaper' ? 'background' : 'clock'] = definition.id
  box.append(canvas)
  return { draw: startCanvasLayer(canvas, definition, new URLSearchParams(item.params)) }
}

/** チャットボックス。デザインのCSSは [data-chat='<id>'] で効くので、箱の中の ol に属性を持たせる */
const mountChat = (box: HTMLElement, item: OverlayItem, { demo, hub }: MountContext): MountedItem => {
  const definition = chats.find((candidate) => candidate.id === item.id)
  if (!definition) throw new Error(`${NOUNS.chat}「${item.id}」はレジストリに登録されていません`)

  const root = document.createElement('ol')
  root.className = 'chat'
  root.dataset.chat = definition.id
  box.append(root)

  const search = new URLSearchParams(item.params)
  // プレビューではサンプルの書き込みを流す（匿名IRCへはつながない）
  if (demo) search.set('demo', 'true')
  const params = parseParams(definition.schema, search)
  for (const [name, value] of Object.entries(definition.cssVariables(params))) {
    root.style.setProperty(name, value)
  }

  const view = createChatView(root, { ...params, lookupBadge: (badge) => hub.lookupBadge(badge) })

  if (sourceOf(params).type === 'demo') {
    startDemo(view)
    return {}
  }

  hub.require({ badges: params.badges, thirdparty: params.thirdparty })
  hub.listen({
    onEvent: (event) => {
      switch (event.type) {
        case 'message':
          view.add(hub.decorate(event.message, params.thirdparty))
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
        case 'notice':
          view.addNotice(event.text)
          break
        case 'room':
          break
      }
    },
    onStatus: (status) => {
      view.addNotice(status === 'disconnected' ? 'チャットとの接続が切れました。再接続します…' : 'チャットに再接続しました')
    },
  })
  return { usesChat: true }
}

/** アラート。Workerから押し出されてくる1件ずつを順に再生する（列は queue.ts が持つ） */
const mountAlerts = (box: HTMLElement, item: OverlayItem, { key, demo }: MountContext): MountedItem => {
  // この素材は配信者が決めるパラメータを持たない（空でないクエリは誤りとして知らせる）
  parseParams({}, new URLSearchParams(item.params))

  const root = document.createElement('div')
  root.className = 'alerts'
  root.dataset.alerts = ''
  box.append(root)

  const view = createAlertView(root)
  let queue = EMPTY_QUEUE

  /** 再生中のアラートを表示し、終わったら次へ進む */
  const play = (): void => {
    if (queue.current === null) return
    void view
      .show(queue.current)
      // 素材が読めなくても後続のアラートは再生するが、黙って飛ばさず画面に知らせる
      .catch((error: unknown) => view.setNotice(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        queue = advance(queue)
        play()
      })
  }

  /** 再生する列に1件積む。いま何も再生していなければ、その場で再生を始める */
  const showAlert = (alert: Alert): void => {
    const idle = queue.current === null
    queue = enqueue(queue, alert)
    if (idle) play()
  }

  if (demo) {
    // プレビューではWorkerにつながず、サンプルのアラートを順に流す（どこに出るかを確かめるため）
    startSampleCycle(demoAlerts, DEMO_ALERT_INTERVAL_MS, showAlert)
    return {}
  }

  connectAlerts(key, {
    onAlert: (alert) => {
      // 前回の失敗のお知らせが残っていれば消す
      view.setNotice(null)
      showAlert(alert)
    },
    onStatus: (status) => view.setNotice(status === 'disconnected' ? 'Workerとの接続が切れました。再接続します…' : null),
    onWarning: (message) => view.setNotice(message),
  })
  return {}
}

/** サイドスーパー。cron が作った文言を定期的に読みに行って映す */
const mountSideSuper = (box: HTMLElement, item: OverlayItem, { key, demo }: MountContext): MountedItem => {
  const params = parseParams(sideSuperParamSchema, new URLSearchParams(item.params))

  const root = document.createElement('div')
  root.className = 'side-super'
  root.dataset.sideSuper = ''
  // 寄せる向きはCSS（src/side-super/side-super.css）が data-position から決める
  root.dataset.position = params.position
  box.append(root)

  const view = createSideSuperView(root)

  if (demo) {
    // プレビューではWorkerにつながず、サンプルの文言を順に流す
    startSampleCycle(demoSideSupers, DEMO_SAMPLE_INTERVAL_MS, (lines) => view.setLines(lines))
    return {}
  }

  const api = createSideSuperApi(callWorker, key)
  const read = async (): Promise<void> => {
    view.setLines(await api.read())
    // 前の読み出しの失敗が箱に出ていれば消す（直ったのに赤い表示が残ったままにしない）。
    // 消すのは読み出しの失敗だけで、チャットの接続の失敗は読み直しでは直らないので残す
    clearError(box, 'read')
  }

  // 1回目は起動の一部として扱い、失敗はこの箱に出す（ほかの素材は動かし続ける）
  void read().catch((error: unknown) => showError(error, NOUNS.sideSuper, box, 'read'))

  return {
    task: {
      intervalMs: SIDE_SUPER_INTERVAL_MS,
      run: () => {
        void read().catch((error: unknown) => {
          // 一時的な通信の失敗で配信画面を汚さない。前回の文言をそのまま映したまま、原因は記録に残す
          console.error('サイドスーパーを読み込めませんでした', error)
        })
      },
    },
  }
}

/**
 * 注目コメント。取り上げている発言1件を定期的に読みに行き、アイコン・名前・本文の箱で映す。
 *
 * モデレーターの操作で映しているものが消えたら映すのをやめる（withRemoval）。配信画面に残ったままに
 * すると取り返しがつかないので、発言そのものは使わなくてもチャットの受け取りにつなぐ。
 */
const mountFocus = (box: HTMLElement, item: OverlayItem, { key, demo, hub }: MountContext): MountedItem => {
  // この素材は配信者が決めるパラメータを持たない（取り上げる相手は Worker が持つ）
  parseParams({}, new URLSearchParams(item.params))

  const root = document.createElement('div')
  root.className = 'focus'
  root.dataset.focus = ''
  box.append(root)

  const view = createFocusView(root)

  if (demo) {
    // プレビューでは取り上げているものを読まず、サンプルを順に流す（匿名IRCへもつながない）
    startSampleCycle(demoFocused, DEMO_SAMPLE_INTERVAL_MS, (focused) => view.setFocused(focused))
    return {}
  }

  const api = createFocusOverlayApi(callWorker, key)

  /** いま取り上げている1件と、映している1件。ここだけが持ち、書き換えたら必ず画面へ反映する */
  let state: FocusState = NO_FOCUS
  const update = (next: FocusState): void => {
    if (next === state) return
    state = next
    view.setFocused(state.shown)
  }

  const read = async (): Promise<void> => {
    update(withTarget(state, await api.read()))
    // 前の読み出しの失敗が箱に出ていれば消す（直ったのに赤い表示が残ったままにしない）。
    // 消すのは読み出しの失敗だけで、チャットの接続の失敗は読み直しでは直らないので残す
    clearError(box, 'read')
  }

  // 1回目は起動の一部として扱い、失敗はこの箱に出す
  void read().catch((error: unknown) => showError(error, NOUNS.focus, box, 'read'))

  // 要るものを伝えないのは、発言そのものを映さず、バッジもエモートも使わないためである
  hub.listen({
    onEvent: (event) => {
      switch (event.type) {
        case 'delete':
          update(withRemoval(state, { type: 'message', messageId: event.id }))
          break
        case 'clear-user':
          update(withRemoval(state, { type: 'user', login: event.login }))
          break
        case 'clear-all':
          update(withRemoval(state, { type: 'all' }))
          break
        case 'message':
        case 'room':
        case 'notice':
          // 新しい発言と接続の知らせは映すものに関係しない（映す1件は配信者が /comments/ で選ぶ）
          break
      }
    },
    onStatus: () => {
      // 切断・再接続は出さない。再接続は connection.ts が続けるので、映しているものはそのまま残す
    },
  })

  return {
    usesChat: true,
    task: {
      intervalMs: FOCUS_INTERVAL_MS,
      run: () => {
        void read().catch((error: unknown) => {
          // 一時的な通信の失敗で配信画面を汚さない。前に読んだ指定のまま映したまま、原因は記録に残す
          console.error('取り上げているものを読み込めませんでした', error)
        })
      },
    },
  }
}

/**
 * ワイプ。バラエティ番組のワイプのように、チャットの発言を1件ずつ、発言した人のアイコンの枠と吹き出しで出す。
 *
 * 読み上げはこの素材が自分で行い、読み上げているあいだだけ吹き出しを出す（音と表示を合わせるため。順番の進め方は
 * src/wipe/runner.ts）。読み上げの設定とミュートは裏方の読み上げと同じものを使う（src/speech/voice.ts）。
 * ミュート中は読まずに、文の長さに応じた時間だけ出す。
 *
 * 注意: 声の準備（設定の読み出しと合成先の確認）に失敗したら、この素材は何も出さずに失敗を箱に出す（Fail-Fast）。
 * 準備ができるまでに届いた発言は並べない（どの発言を出すかを、読み上げない人の設定なしには決められないため）。
 * 注意: 同じ発言を裏方の読み上げも読むと二重になるので、裏方の読み上げは構成にワイプがあれば始めない（src/speech/task.ts）。
 */
const mountWipe = (box: HTMLElement, item: OverlayItem, { key, demo, hub }: MountContext): MountedItem => {
  // この素材は配信者が決めるパラメータを持たない（読み上げの設定は Worker が持つ）
  parseParams({}, new URLSearchParams(item.params))

  const root = document.createElement('div')
  root.className = 'wipe'
  root.dataset.wipe = ''
  box.append(root)

  const view = createWipeView(root)

  if (demo) {
    // プレビューではチャットにつながず、読み上げもせずにサンプルを順に出す
    startSampleCycle(demoWipeComments, DEMO_SAMPLE_INTERVAL_MS, (shown) => view.show(shown))
    return {}
  }

  const api = createWipeOverlayApi(callWorker, key)
  /** 声と順番の進め方。声の準備ができるまでは null */
  let started: { readonly voice: SpeechVoice; readonly runner: WipeRunner } | null = null

  void startSpeechVoice({
    key,
    box,
    noun: NOUNS.wipe,
    // ミュートしたら鳴っている1件を止める（吹き出しは少し残してから次へ進み、以降は読まずに出す）
    onMute: (muted) => {
      if (muted) started?.runner.stopSpeaking()
    },
  })
    .then(({ voice }) => {
      const runner = createWipeRunner({
        lookupIcon: (login) => api.lookupIcon(login),
        speak: (text, signal) => voice.speak(text, signal),
        muted: () => voice.muted(),
        wait: waitOrAbort,
        show: (shown) => {
          view.show(shown)
          // 前の1件の失敗が箱に出ていれば消す（直ったのに赤い表示が残ったままにしない）
          clearError(box, 'read')
        },
        hide: () => view.hide(),
        onError: (error) => showError(error, NOUNS.wipe, box, 'read'),
      })
      started = { voice, runner }
    })
    .catch((error: unknown) => showError(error, NOUNS.wipe, box, 'layer'))

  // 要るものを伝えないのは、バッジもサードパーティエモートも使わないためである
  hub.listen({
    onEvent: (event) => {
      if (started === null) return
      const { voice, runner } = started
      switch (event.type) {
        case 'message': {
          // 出すかどうかは、届いた時点の読み上げの設定で決める（読み上げない人を追加したら次の発言から効く）
          const { readName, maxLength, ignoreLogins } = voice.settings()
          const comment = wipeCommentOf(hub.decorate(event.message, false), { readName, maxLength, ignoreLogins })
          if (comment !== null) runner.enqueue(comment)
          break
        }
        case 'delete':
          runner.remove((comment) => comment.messageId === event.id)
          break
        case 'clear-user':
          runner.remove((comment) => comment.login === event.login)
          break
        case 'clear-all':
          runner.remove(() => true)
          break
        case 'room':
        case 'notice':
          // 接続の知らせはワイプに関係しない
          break
      }
    },
    onStatus: () => {
      // 切断・再接続は出さない。再接続は connection.ts が続けるので、出している1件はそのまま出しきる
    },
  })

  return { usesChat: true }
}

/** 素材1つを起動する */
/**
 * 手書き。配信者が描く画面（/draw/）で引いた線が中継先（worker/draw-channel.ts）から届く。
 *
 * 届いた線は集まりへ積み上げ、毎フレームそこから描き直す（フレーム間の状態を持たない）。
 * 中継先には貯める仕組みが無いので、開いたときに保存されているもの（KV）を1度読み、それを初期状態にしてから
 * つなぐ（issue #133）。間引きとKVの反映の遅れのぶん、描いた直後に開き直すと最後の数本は欠けることがある。
 */
const mountDraw = (box: HTMLElement, item: OverlayItem, { key, demo }: MountContext): MountedItem => {
  // この素材は配信者が決めるパラメータを持たない（描くものは配信者がその場で決める）
  parseParams({}, new URLSearchParams(item.params))

  const canvas = document.createElement('canvas')
  canvas.dataset.draw = ''
  box.append(canvas)

  // プレビューでは中継先へつながずサンプルを描く（そのとき描いていなければ何も出ず、置いた場所を確かめられない）
  let strokes: Strokes = demo ? { strokes: demoStrokes } : NO_STROKES

  /** 中継先へつないで、これから引かれる線を受け取る */
  const connectRelay = (): void =>
    connectDrawViewer(key, {
      onMessage: (message) => {
        strokes = applyDrawMessage(strokes, message)
      },
      onStatus: (status) => {
        // 切断は出さない。手書きの箱はふつう画面全体に置くので、失敗の表示が配信画面全体を塗ってしまう（issue #174）。
        // つなぎ直しは src/core/socket.ts が続け、描いた線はそのまま残す。つなぎ直せたら前の知らせを消す
        if (status === 'reconnected') clearError(box, 'read')
      },
      onWarning: (message) => {
        clearError(box, 'read')
        showError(new Error(message), NOUNS.draw, box, 'read')
      },
    })

  if (!demo) {
    // 中継先は開いている接続の間だけの通り道なので、保存されているものを先に読んでから初期状態として描く
    // （読まないと、ブラウザソースを作り直したときにそれまでの図が消える。issue #133）。
    // 読めなかったときは箱に出したうえでつなぐ（保存ぶんが無くても、これから引かれる線は映せる）
    void createDrawOverlayApi(callWorker, key)
      .read()
      .then(({ strokes: saved }) => {
        strokes = { strokes: [...saved, ...strokes.strokes] }
      })
      .catch((error: unknown) => showError(error, NOUNS.draw, box, 'read'))
      .finally(connectRelay)
  }

  return { draw: startCanvasSurface(canvas, (ctx, width, height) => drawStrokes(ctx, strokes, { width, height })) }
}

/**
 * 字幕。アプリの枠の音声認識が送る暫定・確定の文が、字幕の中継先（worker/draw-channel.ts を caption の名前で使う）から届く
 * （issue #190）。
 *
 * 届いた文は captions.ts の積み上げへ入れ、映す行は毎フレーム「いまの時刻」から決め直す（確定した行を一定時間で消すため。
 * フレーム間の状態は持たない）。中継先は貯めないので、開く前に話したことは映らない（字幕は流れていくものなので読み直さない）。
 */
const mountCaption = (box: HTMLElement, item: OverlayItem, { key, demo }: MountContext): MountedItem => {
  // この素材は配信者が決めるパラメータを持たない（見た目の既定は captions.ts と caption.css が決め切る）
  parseParams({}, new URLSearchParams(item.params))

  const root = document.createElement('div')
  root.className = 'caption'
  root.dataset.caption = ''
  box.append(root)

  const view = createCaptionView(root)
  let state: CaptionState = NO_CAPTIONS
  /** 届いた時刻は、描画ループに渡される時刻と同じ時計（performance.now）で測る */
  const receive = (message: CaptionMessage): void => {
    state = applyCaptionMessage(state, message, performance.now())
  }

  if (demo) {
    // プレビューでは中継先へつながず、サンプルの発話を順に流す（話していなければ何も出ず、置いた場所を確かめられない）
    startSampleCycle(demoCaptionMessages, DEMO_CAPTION_INTERVAL_MS, receive)
  } else {
    connectCaptionViewer(key, {
      onMessage: receive,
      onStatus: (status) => {
        // 切断は出さない。字幕の箱はふつう画面全体に置くので、失敗の表示が配信画面全体を塗ってしまう（手書きと同じ。issue #174）。
        // つなぎ直しは src/core/socket.ts が続ける。つなぎ直せたら前の知らせを消す
        if (status === 'reconnected') clearError(box, 'read')
      },
      onWarning: (message) => {
        clearError(box, 'read')
        showError(new Error(message), NOUNS.caption, box, 'read')
      },
    })
  }

  return { draw: (elapsedMs) => view.render(visibleCaptions(state, elapsedMs)) }
}

/**
 * 再生中の曲。裏方のページで流しているBGMの曲名とクレジット表記を映す（issue #152）。
 *
 * 切り替えは裏方のページと同じ WebSocket（/api/overlay/bgm/socket）で押し出してもらう。ポーリングにしないのは、
 * 曲を変えてから表示が変わるまでに数十秒ずれると、流れている曲と違うクレジットを映すことになるためである。
 * つながるたびに（初めての接続でも、つなぎ直しでも）読み直し、つながっていない間の切り替えを取りこぼさない。
 */
const mountBgm = (box: HTMLElement, item: OverlayItem, { key, demo }: MountContext): MountedItem => {
  // この素材は配信者が決めるパラメータを持たない（流す曲は /bgm/ で選ぶ）
  parseParams({}, new URLSearchParams(item.params))

  const root = document.createElement('div')
  root.className = 'bgm-credit'
  root.dataset.bgmCredit = ''
  box.append(root)

  const view = createBgmCreditView(root)

  if (demo) {
    // プレビューではWorkerにつながず、サンプルの曲を順に流す
    startSampleCycle(demoBgmTracks, DEMO_SAMPLE_INTERVAL_MS, (track) => view.setTrack(track))
    return {}
  }

  const api = createBgmOverlayApi(callWorker, key)
  /**
   * 失敗を箱に出す。前の失敗は消してから出す（つながらないあいだ、つなぎ直しのたびに警告が届くので、
   * 消さずに追加すると配信画面に失敗の表示が積み上がる）
   */
  const showReadError = (error: unknown): void => {
    clearError(box, 'read')
    showError(error, NOUNS.bgm, box, 'read')
  }
  /** 映したものの世代。読み直しの応答より先に押し出しが届いたとき、古い応答で上書きしないために使う */
  let shown = 0
  const show = (nowPlaying: BgmNowPlaying): void => {
    shown += 1
    view.setTrack(nowPlaying.track)
    // 前の失敗が箱に出ていれば消す（直ったのに赤い表示が残ったままにしない）
    clearError(box, 'read')
  }
  const read = (): void => {
    const at = shown
    void api
      .read()
      .then((nowPlaying) => {
        if (shown === at) show(nowPlaying)
      })
      .catch((error: unknown) => {
        // 読んでいる間に押し出しで新しい曲を映せていれば、古い読み出しの失敗は出さない
        if (shown === at) showReadError(error)
      })
  }

  // 1回目は起動の一部として扱い、失敗はこの箱に出す（ほかの素材は動かし続ける）
  read()

  connectSocket(
    socketUrl(BGM_SOCKET_PATH, { key }),
    {
      onMessage: (text) => {
        try {
          show(parseBgmNowPlaying(text))
        } catch (error) {
          showReadError(error)
        }
      },
      // つながるたびに読み直す。初めての接続でも、読んでからつながるまでの間に切り替えられていたかもしれないため
      onOpen: read,
      onStatus: () => {
        // 切断・再接続は出さない。つながったときの読み直しは onOpen が受け持ち、映している曲はそのまま残す
      },
      onWarning: (message) => showReadError(new Error(message)),
    },
    BGM_SOCKET_HINT,
  )
  return {}
}

/**
 * タブの映像。配信者が Chrome 拡張（extension/）で取り込んだ Chrome のタブ1枚の映像と音を映す（issue #164）。
 *
 * 映像と音は送り手から WebRTC で同じPCの中を直接届き、Workerを通るのはつなぐための連絡だけである
 * （中継先は worker/tab-channel.ts、連絡への応じ方は src/tab/receiver.ts）。音も <video> から鳴らすので、
 * OBSのブラウザソースで「OBSで音声を制御する」を有効にしてもらう（docs/guide/tab.md）。
 *
 * 配信者が拡張で映す範囲を選んでいれば（issue #166）、その範囲だけを縦横比を保って箱に収める（src/tab/crop.ts の layoutCrop）。
 * canvas に描き直さず <video> を外枠の中で拡大してずらすので、毎フレームの処理は増えない。
 *
 * 注意: 何も届いていないあいだ（タブを閉じた・映すのをやめた）は透明にするだけで、
 * 箱に失敗を出さない。配信中に普通に起こる操作のため。箱に出すのは中継先につながらないときだけである。
 */
const mountTab = (box: HTMLElement, item: OverlayItem, { key, demo }: MountContext): MountedItem => {
  // この素材は配信者が決めるパラメータを持たない（映すタブは拡張のショートカットでその場で決める）
  parseParams({}, new URLSearchParams(item.params))

  if (demo) {
    // プレビューでは中継先へつながず、置いた場所と大きさが分かる見本を出す（何も映していないと透明で確かめられない）
    const sample = document.createElement('div')
    sample.className = 'tab-sample'
    sample.textContent = 'タブの映像'
    box.append(sample)
    return {}
  }

  // 映す範囲（issue #166）だけを見せる外枠。映像を拡大してずらし、外枠からはみ出した分を隠す
  const clip = document.createElement('div')
  clip.className = 'tab-clip'
  clip.hidden = true
  const video = document.createElement('video')
  video.className = 'tab-video'
  video.autoplay = true
  video.playsInline = true
  video.hidden = true
  clip.append(video)
  box.append(clip)

  /** 送り手から届いた映す範囲（null はタブ全体） */
  let crop: TabCrop | null = null
  const setRect = (element: HTMLElement, rect: Rect): void => {
    Object.assign(element.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
  }
  /** 箱・映像の大きさ・範囲のどれかが変わったら置き直す。映像の大きさがまだ分からなければ外枠ごと隠す */
  const place = (): void => {
    const layout = layoutCrop({ width: box.clientWidth, height: box.clientHeight }, { width: video.videoWidth, height: video.videoHeight }, crop)
    clip.hidden = layout === null
    if (layout === null) return
    setRect(clip, layout.clip)
    setRect(video, layout.video)
  }
  // 映像の大きさは、届いたとき・映すタブの大きさが変わったときに変わる
  video.addEventListener('resize', place)
  video.addEventListener('loadedmetadata', place)
  // 箱の大きさは、管理画面で構成を変えたときに変わる
  new ResizeObserver(place).observe(box)

  const showWarning = (message: string): void => {
    // 前に出した知らせを消してから出す（つなぎ直しは繰り返すので、消さないと配信画面に積み上がる）
    clearError(box, 'read')
    showError(new Error(message), NOUNS.tab, box, 'read')
  }

  const receiver = createTabReceiver<MediaStream>({
    // 合成ページごとに名前を分ける（OBSの別のシーンにも置かれていると、送り手は名前ごとに接続を作る）
    viewerId: crypto.randomUUID(),
    send: (message) => {
      socket.send(message)
    },
    openPeer: openReceiverPeer,
    onStream: (stream) => {
      // 同じ映像をセットし直すと読み込みがやり直しになり、再生中の play() が中断されて失敗する
      if (video.srcObject === stream) return
      video.srcObject = stream
      video.hidden = stream === null
      if (stream === null) return
      // OBSのブラウザソースは操作なしで音を鳴らせる（#163 で確かめた）。鳴らせなければ理由を箱に出す
      video.play().catch((error: unknown) => showWarning(`タブの映像を再生できませんでした: ${error instanceof Error ? error.message : String(error)}`))
    },
    onCrop: (next) => {
      crop = next
      place()
    },
    onWarning: showWarning,
  })

  const socket = connectTabViewer(key, {
    onMessage: (message) => receiver.receive(message),
    // つながるたびに名乗る（つなぎ直したあとも、送り手が映していればまた offer が届く）
    onOpen: () => {
      clearError(box, 'read')
      receiver.opened()
    },
    onStatus: (status) => {
      // 中継先との接続が切れても、WebRTC の映像はそのまま流れ続けるので出さない。つなぎ直せたら前の知らせを消す
      if (status === 'reconnected') clearError(box, 'read')
    },
    onWarning: showWarning,
  })
  return {}
}

/**
 * 作業ログ。その配信の開発の出来事と章の見出しを、時刻つきで新しい順に映す（issue #211）。
 *
 * 増えた1行はアラートと同じ配送先から WebSocket（/api/overlay/work-log/socket）で押し出してもらう。開いたとき・つながるたび・
 * 定期的に一覧を読み直し、つながっていない間に増えた行と、配信が変わったこと（前の配信の行を消す）を拾う。
 * 読み直しは一覧を置き換えるが、読んでいる間に押し出された行は重ねて残す（古い読み出しで新しい行を消さないため）。
 * 読み出しが重なったとき（開いたときとつながったときなど）は、いちばん新しく始めた読み出しの結果だけを映す。
 */
const mountWorkLog = (box: HTMLElement, item: OverlayItem, { key, demo }: MountContext): MountedItem => {
  // この素材は配信者が決めるパラメータを持たない（並べるものは Worker が決める）
  parseParams({}, new URLSearchParams(item.params))

  const root = document.createElement('div')
  root.className = 'work-log'
  root.dataset.workLog = ''
  box.append(root)

  const view = createWorkLogView(root)

  if (demo) {
    // プレビューではWorkerにつながず、サンプルの行が1行ずつ増えていく場面を順に流す
    startSampleCycle(demoWorkLogScenes, DEMO_SAMPLE_INTERVAL_MS, (scene) => view.setEntries(scene))
    return {}
  }

  const api = createWorkLogApi(callWorker, key)
  let entries: WorkLogEntry[] = []
  /** 読んでいる最中の読み出しごとの、その間に押し出された行。読み終えたら結果に重ねる */
  const pushedWhileReading = new Set<WorkLogEntry[]>()
  const show = (next: WorkLogEntry[]): void => {
    entries = next
    view.setEntries(entries)
  }
  const showReadError = (error: unknown): void => {
    clearError(box, 'read')
    showError(error, NOUNS.workLog, box, 'read')
  }
  /** いちばん新しく始めた読み出しの世代。重なった読み出しのうち、古いものの結果で新しい一覧を上書きしないために使う */
  let latestRead = 0
  const read = async (): Promise<void> => {
    latestRead += 1
    const generation = latestRead
    const pushed: WorkLogEntry[] = []
    pushedWhileReading.add(pushed)
    try {
      const readEntries = await api.read()
      if (generation !== latestRead) return
      show(mergeEntries(readEntries, pushed, WORK_LOG_LIMIT))
      // 前の失敗が箱に出ていれば消す（直ったのに赤い表示が残ったままにしない）
      clearError(box, 'read')
    } finally {
      pushedWhileReading.delete(pushed)
    }
  }

  // 1回目は起動の一部として扱い、失敗はこの箱に出す（ほかの素材は動かし続ける）
  void read().catch(showReadError)

  connectSocket(
    socketUrl(WORK_LOG_SOCKET_PATH, { key }),
    {
      onMessage: (text) => {
        try {
          const entry = parseWorkLogEntry(text)
          for (const pushed of pushedWhileReading) pushed.push(entry)
          show(mergeEntries(entries, [entry], WORK_LOG_LIMIT))
        } catch (error) {
          showReadError(error)
        }
      },
      // つながるたびに読み直す。つながっていない間に増えた行を取りこぼさないため
      onOpen: () => void read().catch(showReadError),
      onStatus: () => {
        // 切断・再接続は出さない。つながったときの読み直しは onOpen が受け持ち、映している行はそのまま残す
      },
      onWarning: (message) => showReadError(new Error(message)),
    },
    WORK_LOG_SOCKET_HINT,
  )

  return {
    task: {
      intervalMs: WORK_LOG_INTERVAL_MS,
      run: () => {
        void read().catch((error: unknown) => {
          // 一時的な通信の失敗で配信画面を汚さない。映している行はそのまま残し、原因は記録に残す（サイドスーパーと同じ）
          console.error('作業ログを読み込めませんでした', error)
        })
      },
    },
  }
}

/**
 * 作業机。視聴者が !task で宣言した作業を1人1行で映し、!done で完了した行を祝う（issue #207）。
 *
 * 作業机が変わるたびに、アラートと同じ配送先から WebSocket（/api/overlay/task-desk/socket）で丸ごと押し出してもらい、
 * 届いたもので置き換える。開いたとき・つながるたび・定期的に読み直し、つながっていない間の変化と配信の切り替わりを拾う。
 * 読んでいるあいだに押し出しが届いたら、読んだ結果も読み出しの失敗も捨てる（押し出しのほうが新しいので、古い作業机に戻さず、
 * 映せている作業机に古い失敗を重ねない）。読み出しが重なったときは、いちばん新しく始めた読み出しの結果だけを映す。
 * みんなの作業時間の合計（issue #209）は届いたものを持っておき、毎フレーム現在時刻まで進めて映す（読み直しを待たずに時間が進む）。
 */
const mountTaskDesk = (box: HTMLElement, item: OverlayItem, { key, demo }: MountContext): MountedItem => {
  // この素材は配信者が決めるパラメータを持たない（並べるものは視聴者のコマンドで決まる）
  parseParams({}, new URLSearchParams(item.params))

  const root = document.createElement('div')
  root.className = 'task-desk'
  root.dataset.taskDesk = ''
  box.append(root)

  const view = createTaskDeskView(root)
  /** 映している作業時間の合計。届くたびに置き換え、毎フレーム現在時刻まで進めて映す */
  let workTime: TaskDeskWorkTime | null = null
  const draw = (): void => view.renderWorkTime(workTime, Date.now())
  const show = (snapshot: TaskDeskSnapshot): void => {
    view.setEntries(snapshot.entries)
    workTime = snapshot.workTime
  }

  if (demo) {
    // プレビューではWorkerにつながず、宣言が増えて1人が完了する場面を順に流す。合計は場面を映した時刻から進める
    startSampleCycle(demoTaskDeskScenes, DEMO_SAMPLE_INTERVAL_MS, (scene) =>
      show({ entries: scene.entries, workTime: { ...scene.workTime, measuredAt: new Date(Date.now()).toISOString() } }),
    )
    return { draw }
  }

  const api = createTaskDeskApi(callWorker, key)
  const showReadError = (error: unknown): void => {
    clearError(box, 'read')
    showError(error, NOUNS.taskDesk, box, 'read')
  }
  /** いちばん新しく始めた読み出しの世代。重なった読み出しのうち、古いものの結果で新しい作業机を上書きしないために使う */
  let latestRead = 0
  /** 押し出しを受け取った回数。読んでいるあいだに押し出しが届いたかを見分けるために使う */
  let pushCount = 0
  /**
   * 作業机を読み直す。失敗は onError に渡すが、あとから始めた読み出しや押し出しに追い越されていれば捨てる。
   *
   * @param onError 追い越されていない失敗の扱い（箱に出す・記録に残すだけ、を呼び出し側が決める）
   */
  const read = async (onError: (error: unknown) => void): Promise<void> => {
    latestRead += 1
    const generation = latestRead
    const pushCountAtStart = pushCount
    const isStale = (): boolean => generation !== latestRead || pushCountAtStart !== pushCount
    try {
      const snapshot = await api.read()
      if (isStale()) return
      show(snapshot)
      // 前の失敗が箱に出ていれば消す（直ったのに赤い表示が残ったままにしない）
      clearError(box, 'read')
    } catch (error) {
      if (!isStale()) onError(error)
    }
  }

  // 1回目は起動の一部として扱い、失敗はこの箱に出す（ほかの素材は動かし続ける）
  void read(showReadError)

  connectSocket(
    socketUrl(TASK_DESK_SOCKET_PATH, { key }),
    {
      onMessage: (text) => {
        try {
          const snapshot = parseTaskDeskSnapshot(text)
          pushCount += 1
          show(snapshot)
          // 最新の作業机を映せたので、前の読み出しの失敗が箱に出ていれば消す
          clearError(box, 'read')
        } catch (error) {
          showReadError(error)
        }
      },
      // つながるたびに読み直す。つながっていない間の変化を取りこぼさないため
      onOpen: () => void read(showReadError),
      onStatus: () => {
        // 切断・再接続は出さない。つながったときの読み直しは onOpen が受け持ち、映している行はそのまま残す
      },
      onWarning: (message) => showReadError(new Error(message)),
    },
    TASK_DESK_SOCKET_HINT,
  )

  return {
    draw,
    task: {
      intervalMs: TASK_DESK_INTERVAL_MS,
      run: () => {
        void read((error) => {
          // 一時的な通信の失敗で配信画面を汚さない。映している行はそのまま残し、原因は記録に残す（作業ログと同じ）
          console.error('作業机を読み込めませんでした', error)
        })
      },
    },
  }
}

/**
 * ポモドーロ。25分の作業と5分の休憩の残り時間を、画面の隅の札に出す（issue #208）。
 *
 * Worker から受け取るのはタイマー（始めた時刻・一時停止の時刻。止めたら null）だけで、区間と残り時間は毎フレーム
 * 現在時刻から計算する（src/pomodoro/phase.ts。区切りの時刻に押し出しを待たない）。タイマーは始めた・一時停止した・再開した・止めたときに
 * アラートと同じ配送先から WebSocket（/api/overlay/pomodoro/socket）で押し出してもらい、開いたとき・つながるたび・定期的に読み直す。
 * 読んでいるあいだに押し出しが届いたら、読んだ結果も読み出しの失敗も捨てる（作業机と同じ。押し出しのほうが新しい）。
 */
const mountPomodoro = (box: HTMLElement, item: OverlayItem, { key, demo }: MountContext): MountedItem => {
  // この素材は配信者が決めるパラメータを持たない（何を映すかはタイマーで決まる）
  parseParams({}, new URLSearchParams(item.params))

  const root = document.createElement('div')
  root.className = 'pomodoro'
  root.dataset.pomodoro = ''
  box.append(root)

  const view = createPomodoroView(root)
  let timer: PomodoroTimer | null = null
  const draw = (): void => view.render(timer, Date.now())

  if (demo) {
    // プレビューではWorkerにつながず、作業中・休憩中・一時停止中の札を順に流す
    startSampleCycle(demoPomodoroScenes, DEMO_SAMPLE_INTERVAL_MS, (scene) => {
      timer = demoTimerOf(scene, Date.now())
    })
    return { draw }
  }

  const api = createPomodoroOverlayApi(callWorker, key)
  const showReadError = (error: unknown): void => {
    clearError(box, 'read')
    showError(error, NOUNS.pomodoro, box, 'read')
  }
  /** いちばん新しく始めた読み出しの世代。重なった読み出しのうち、古いものの結果で新しいタイマーを上書きしないために使う */
  let latestRead = 0
  /** 押し出しを受け取った回数。読んでいるあいだに押し出しが届いたかを見分けるために使う */
  let pushCount = 0
  /**
   * タイマーを読み直す。失敗は onError に渡すが、あとから始めた読み出しや押し出しに追い越されていれば捨てる。
   *
   * @param onError 追い越されていない失敗の扱い（箱に出す・記録に残すだけ、を呼び出し側が決める）
   */
  const read = async (onError: (error: unknown) => void): Promise<void> => {
    latestRead += 1
    const generation = latestRead
    const pushCountAtStart = pushCount
    const isStale = (): boolean => generation !== latestRead || pushCountAtStart !== pushCount
    try {
      const next = await api.read()
      if (isStale()) return
      timer = next
      // 前の失敗が箱に出ていれば消す（直ったのに赤い表示が残ったままにしない）
      clearError(box, 'read')
    } catch (error) {
      if (!isStale()) onError(error)
    }
  }

  // 1回目は起動の一部として扱い、失敗はこの箱に出す（ほかの素材は動かし続ける）
  void read(showReadError)

  connectSocket(
    socketUrl(POMODORO_SOCKET_PATH, { key }),
    {
      onMessage: (text) => {
        try {
          const next = parsePomodoroSnapshot(text)
          pushCount += 1
          timer = next
          // 最新のタイマーを受け取れたので、前の読み出しの失敗が箱に出ていれば消す
          clearError(box, 'read')
        } catch (error) {
          showReadError(error)
        }
      },
      // つながるたびに読み直す。つながっていない間の変化を取りこぼさないため
      onOpen: () => void read(showReadError),
      onStatus: () => {
        // 切断・再接続は出さない。つながったときの読み直しは onOpen が受け持ち、映している札はそのまま残す（残り時間は進み続ける）
      },
      onWarning: (message) => showReadError(new Error(message)),
    },
    POMODORO_SOCKET_HINT,
  )

  return {
    draw,
    task: {
      intervalMs: POMODORO_INTERVAL_MS,
      run: () => {
        void read((error) => {
          // 一時的な通信の失敗で配信画面を汚さない。映している札はそのまま残し、原因は記録に残す（作業机と同じ）
          console.error('ポモドーロのタイマーを読み込めませんでした', error)
        })
      },
    },
  }
}

/**
 * 市町村紹介（issue #229）。Workerから押し出された呼び出し（市町村と冒頭の一文）を1件ずつ順に流す。
 *
 * 呼び出しはアラートと同じ配送先から WebSocket（/api/overlay/town-tour/socket）で届く。流しはじめたら紹介を Worker に作らせ
 * （GET /api/overlay/town-tour?code=。2〜5秒）、そのあいだは日本地図から市町村へズームする演出で待つ。
 * 場面は再生を始めた時刻・紹介が届いた時刻と現在時刻だけから決める（src/town-tour/timeline.ts）。
 * 流している最中に次の呼び出しが届いたら、いまの1件を流し終えてから順に流す（アラートの列とは別に持つ）。
 *
 * 日本地図（約3.7MB）は起動時に1回だけ読み、読み終えるまでに届いた呼び出しは待たせておく。
 * 紹介を作れなかったときは、黙って何も流さないのではなく、失敗をこの箱に出して次の1件へ進む（次を流しはじめたら消す）。
 *
 * 音（issue #244）は、いつ何を鳴らすかを表（src/town-tour/sound-cues.ts）が決め、ここは鳴らした音の id を覚えて
 * 二重に鳴らさないことと、再生の終わり・失敗で止めることだけを受け持つ。描画のループではなくタイマーで刻むのは、
 * OBSのブラウザソースが映っていないあいだ描画を間引いても、音の時刻をずらさず、終わった1件の音を止めて次へ進むためである。
 * 再生を始められなかった音は、黙って無音で続けずにこの箱に失敗を出す。
 *
 * 冒頭の都道府県当てクイズ（issue #251）は、流しはじめたら Worker に出題を開かせ（POST /api/overlay/town-tour/quiz）、
 * 最初の正解者が同じ WebSocket で届いたら、その時刻をクイズを終えた時刻として再生に書き込む。ヒントは地図の形から
 * 起動時に求めた境界（都道府県ごとの市町村・隣り合う市町村）で作る。プレビューでは出題を開かないので、いつも時間切れになる。
 *
 * 全国制覇マップ（issue #252）は、流しはじめるときに呼び出しのこれまでの記録と境界から制覇数と節目を決めておき
 * （src/town-tour/conquest.ts）、振りを流し終えたら（流しきったら）Worker に記録させる（POST /api/overlay/town-tour/visit）。
 * 試し再生とプレビューは記録しない。記録に失敗しても制覇マップは止めず、失敗をこの箱に出す（Worker も失敗の記録に残す）。
 * 呼び出しのこれまでの記録は押し出した時点のものなので、この箱が記録した市町村を足して、続けて流す1件の地図と数に反映する。
 *
 * ナレーション（issue #255）を読み上げる呼び出しでは、紹介が届いたら冒頭の一文と場面ごとの文の合成を Worker に頼み
 * （POST /api/overlay/town-tour/narration）、音声の長さを読み終えてから紹介を届いたものとして流す（代表画像の読み込みと並べて待つ）。
 * 場面の長さは読み上げの長さで決まる（timeline.ts）。合成・読み込みに失敗した文は、失敗をこの箱に出してその場面だけ無音で流す。
 * 音声の URL は再生を終えたら手放す。
 *
 * レイド元との共通点（issue #275）は、呼び出しのレイド元を添えて紹介と一緒に作らせ、共通点があればレイド元のアイコンを読み込んでから流す
 * （代表画像・ナレーションと並べて待つ）。共通点を作れなかった理由が返ったら、この箱に出し、共通点の代わりに振りを流す。
 */
const mountTownTour = (box: HTMLElement, item: OverlayItem, { key, demo }: MountContext): MountedItem => {
  // この素材は配信者が決めるパラメータを持たない（何を流すかはトリガーと試し再生で決まる）
  parseParams({}, new URLSearchParams(item.params))

  const canvas = document.createElement('canvas')
  canvas.dataset.townTour = ''
  box.append(canvas)

  const api = createTownTourApi(callWorker, key)
  /** 地図を読み終えたら作る。それまでは流しはじめない */
  let renderer: TownTourRenderer | null = null
  /** 地図から求めた市町村の境界（クイズのヒントの材料）。地図を読み終えたら作る */
  let borders: TownBorders | null = null
  /** 流している1件。流していなければ null */
  let playback: Playback | null = null
  /** 流している1件の、読み込み終えた代表画像。画像の無い紹介・まだ届いていなければ null（issue #254） */
  let image: HTMLImageElement | null = null
  /** 流している1件の、読み込み終えたレイド元のアイコン（共通点の場面に添える）。共通点の無い紹介・読み込めなければ null（issue #275） */
  let icon: HTMLImageElement | null = null
  /** 流している1件の、読み込み終えたナレーションの音声。読み上げない再生・まだ届いていなければ null（issue #255） */
  let narration: Narration | null = null
  /** 流している1件のナレーションの音声を手放す（再生を終えたとき） */
  const releaseCurrentNarration = (): void => {
    if (narration !== null) releaseNarration(narration)
    narration = null
  }
  /** 流すのを待っている呼び出し（届いた順） */
  let waiting: readonly TownTourCall[] = []
  /** 流している1件で鳴らした音の id（sound-cues.ts の SoundCue.id） */
  let played = new Set<string>()
  /** 流している1件を、紹介した市町村として記録させたか */
  let visitSent = false
  /** この箱が記録させた市町村のコード。押し出された時点の記録に足して、続けて流す1件の制覇マップに反映する */
  const recordedCodes = new Set<string>()
  /** 市町村のコードごとの、記録させている最中の件数（別の通知で同じ市町村を引くと、送信が重なることがある） */
  const pendingVisits = new Map<string, number>()
  /** Worker が記録を受け付けた市町村のコード。同じ市町村の別の送信が失敗しても、制覇数から外さない */
  const confirmedCodes = new Set<string>()
  /** 呼び出しの記録に、この箱が記録させた市町村を足して、制覇マップを決める */
  const conquestFor = (call: TownTourCall, townBorders: TownBorders): Playback['conquest'] =>
    conquestOf({ ...call, visited: [...new Set([...call.visited, ...recordedCodes])] }, townBorders)
  const sound = createTownTourSoundPlayer((error) => showError(error, NOUNS.townTour, box, 'read'))
  const bgmApi = createBgmOverlayApi(callWorker, key)

  /**
   * 紹介のBGMを鳴らしている再生なら、配信のBGMを下げておく長さを裏方のページへ知らせる（issue #245）。
   *
   * 鳴らしはじめたとき・紹介が届いたとき・紹介を作れなかったときに呼ぶ。プレビューでは配信のBGMを動かさないので送らない。
   * 知らせに失敗しても紹介は止めず、箱に出すだけにする（下げられなくても、配信のBGMが下がったまま残ることはない）。
   */
  const duckStreamBgm = (target: Playback): void => {
    if (demo || !played.has(BGM_START_CUE_ID)) return
    const holdMs = bgmDuckHoldOf(target, Date.now())
    if (holdMs === null) return
    bgmApi.duck(holdMs).catch((error: unknown) => showError(error, NOUNS.townTour, box, 'read'))
  }

  /** 1件を流しはじめ、紹介を作らせ、クイズの出題を開かせる。作らせている間に別の1件へ進んでいたら、届いた結果は捨てる */
  const start = (call: TownTourCall, townBorders: TownBorders): void => {
    clearError(box, 'read')
    played = new Set()
    visitSent = false
    image = null
    icon = null
    const startedAt = Date.now()
    playback = {
      call,
      startedAt,
      intro: { status: 'loading' },
      quiz: { hints: quizHintsOf(quizClueOf(call.code, townBorders)), answer: null, unopenedAt: null },
      conquest: conquestFor(call, townBorders),
    }
    /** いま流しているのが、この呼び出しの再生か（正解者が届くと再生を作り直すので、同じものかではなく呼び出しと始めた時刻で見る） */
    const current = (): Playback | null => (playback !== null && playback.call === call && playback.startedAt === startedAt ? playback : null)
    if (!demo) {
      api.openQuiz(call.quizId, call.code).catch((error: unknown) => {
        showError(error, NOUNS.townTour, box, 'read')
        // 答えても届かない問いを出し続けないよう、まだクイズの最中ならその場で打ち切る
        const target = current()
        const now = Date.now()
        if (target === null || target.quiz.answer !== null || now - target.startedAt >= QUIZ_MS) return
        playback = { ...target, quiz: { ...target.quiz, unopenedAt: now } }
        duckStreamBgm(playback)
      })
    }
    const introduce = demo
      ? new Promise<typeof demoTownTourIntro>((resolve) => window.setTimeout(() => resolve(demoTownTourIntro), DEMO_INTRO_DELAY_MS))
      : api.introduce(call.code, call.raider)
    /**
     * 代表画像のある紹介なら、画像の場面の前に画像を読み込んでおく。読み込めなければ失敗を箱に出し、
     * 画像を外した紹介にして流す（画像の場面を飛ばす。issue #254）
     */
    const withImage = async (intro: TownTourIntro): Promise<{ intro: TownTourIntro; loaded: HTMLImageElement | null }> => {
      if (intro.image === null) return { intro, loaded: null }
      try {
        return { intro, loaded: await loadTownTourImage(intro.image.url) }
      } catch (error) {
        if (current() !== null) showError(error, NOUNS.townTour, box, 'read')
        return { intro: { ...intro, image: null }, loaded: null }
      }
    }
    /**
     * ナレーションを読み上げる呼び出しなら、冒頭の一文と場面ごとの文を合成させ、音声の長さを読み終えておく。
     * 合成・読み込みに失敗した文は失敗を箱に出して null にし、その場面だけ無音で流す（配信者が決めた）
     */
    const withNarration = async (intro: TownTourIntro): Promise<Narration | null> => {
      if (!call.narration) return null
      const texts = narrationTextsOf(call.headline, tourLinesOf(intro, call.name))
      const clipOf = (text: string): Promise<NarrationClip | null> =>
        api
          .narrate(text)
          .then(loadNarrationClip)
          .catch((error: unknown) => {
            if (current() !== null) showError(error, NOUNS.townTour, box, 'read')
            return null
          })
      const [opening = null, ...lines] = await Promise.all([texts.opening, ...texts.lines].map(clipOf))
      return { opening, lines }
    }
    /**
     * 共通点のある紹介なら、レイド元のアイコンを読み込んでおく。読み込めなければ失敗を箱に出し、アイコンなしで共通点を流す（issue #275）。
     * 共通点を作れなかった紹介は、Worker が返した理由を箱に出す（共通点の代わりに振りを流す）
     */
    const withIcon = async (intro: TownTourIntro): Promise<HTMLImageElement | null> => {
      if (intro.bondFailure !== null && current() !== null) showError(new Error(intro.bondFailure), NOUNS.townTour, box, 'read')
      if (intro.bond === null) return null
      try {
        return await loadTownTourImage(intro.bond.raiderIcon)
      } catch (error) {
        if (current() !== null) showError(error, NOUNS.townTour, box, 'read')
        return null
      }
    }
    // 代表画像・アイコンの読み込みとナレーションの合成は関わりがないので、並べて待つ
    const prepared = introduce.then(async (intro) => {
      const [shown, raiderIcon, voiced] = await Promise.all([withImage(intro), withIcon(intro), withNarration(intro)])
      return { ...shown, raiderIcon, voiced }
    })
    prepared.then(
      ({ intro, loaded, raiderIcon, voiced }) => {
        const target = current()
        if (target === null) {
          // 読み込んでいるあいだに別の1件へ進んでいたら、使わない音声を手放す
          if (voiced !== null) releaseNarration(voiced)
          return
        }
        image = loaded
        icon = raiderIcon
        narration = voiced
        playback = { ...target, intro: { status: 'ready', intro, readyAt: Date.now(), narration: voiced } }
        // 終わりが決まったので、配信のBGMを下げておく長さを再生の終わりまでに送り直す
        duckStreamBgm(playback)
      },
      (error: unknown) => {
        const target = current()
        if (target === null) return
        playback = { ...target, intro: { status: 'failed' } }
        // 紹介を作れなかった再生では、鳴りはじめていた BGM も止めて何も鳴らさない。下げていた配信のBGMもすぐ戻す
        sound.stop()
        duckStreamBgm(playback)
        showError(error, NOUNS.townTour, box, 'read')
      },
    )
  }

  /** 待っている先頭を流しはじめる。地図を読み終えていなければ、読み終えたときに呼び直す */
  const startNext = (): void => {
    const [next, ...rest] = waiting
    if (renderer === null || borders === null || playback !== null || next === undefined) return
    waiting = rest
    try {
      start(next, borders)
    } catch (error) {
      // 想定外の呼び出しで1件が黙って消えないよう、失敗を箱に出して次の1件へ進む
      playback = null
      showError(error, NOUNS.townTour, box, 'read')
      startNext()
    }
  }

  /**
   * クイズの最初の正解者を、流している再生に書き込む。届いた時刻がクイズを終えた時刻になる（timeline.ts の quizEndOf）。
   * 別の出題の正解者・正解者が決まった後・クイズの長さを過ぎてから届いた正解者は出さない（画面はもう時間切れで先へ進んでいる）。
   */
  const acceptAnswer = (quizId: string, userName: string): void => {
    const now = Date.now()
    if (playback === null || playback.call.quizId !== quizId || playback.quiz.answer !== null || now - playback.startedAt >= QUIZ_MS) return
    playback = { ...playback, quiz: { ...playback.quiz, answer: { userName, answeredAt: now } } }
    // 終わりが早まったので、配信のBGMを下げておく長さを送り直す
    duckStreamBgm(playback)
  }

  const enqueue = (call: TownTourCall): void => {
    waiting = [...waiting, call]
    startNext()
  }

  void api
    .japanMap()
    .then((topology) => {
      renderer = createTownTourRenderer(decodeTownShapes(topology))
      borders = decodeTownBorders(topology)
      startNext()
    })
    .catch((error: unknown) => showError(error, NOUNS.townTour, box, 'layer'))

  /**
   * 流している1件を流しきっていたら、紹介した市町村として Worker に記録させる（1件につき1回）。
   * プレビューと、記録しない再生（試し再生）・流しきっていない再生では送らない。記録に失敗しても紹介は止めず、箱に出すだけにする。
   */
  const recordVisitIfDue = (target: Playback, now: number): void => {
    const recordAt = visitRecordAtOf(target)
    const { visit, code } = target.call
    if (demo || visitSent || visit === null || recordAt === null || now - target.startedAt < recordAt) return
    visitSent = true
    // 応答を待つあいだに次の1件を流しはじめても制覇数に入るよう、送った時点で足しておき、記録できなかったら外す
    recordedCodes.add(code)
    pendingVisits.set(code, (pendingVisits.get(code) ?? 0) + 1)
    /** この送信が終わったので、送信中の件数を1つ減らし、まだ同じ市町村を送っている最中かを返す */
    const settle = (): boolean => {
      const remaining = (pendingVisits.get(code) ?? 1) - 1
      if (remaining === 0) pendingVisits.delete(code)
      else pendingVisits.set(code, remaining)
      return remaining > 0
    }
    api.recordVisit(code, visit).then(
      () => {
        settle()
        confirmedCodes.add(code)
        recordedCodes.add(code)
      },
      (error: unknown) => {
        // 同じ市町村を別に送っている最中か、もう記録を受け付けられていれば、制覇数から外さない
        if (!settle() && !confirmedCodes.has(code)) {
          recordedCodes.delete(code)
          // 足した市町村込みで流しはじめた後の1件があれば、その制覇マップを決め直す（流している1件は止めない）
          if (playback !== null && playback.call !== target.call && borders !== null) {
            playback = { ...playback, conquest: conquestFor(playback.call, borders) }
          }
        }
        showError(error, NOUNS.townTour, box, 'read')
      },
    )
  }

  /** 流している1件を終える時刻を過ぎていたら終え、次の1件へ進む */
  const finishIfDone = (now: number): void => {
    if (playback === null || !sceneAt(playback, now).done) return
    // タイマーが止められていて記録の時刻を確かめられないまま終わった1件も、流しきったものとして記録させる
    recordVisitIfDue(playback, now)
    playback = null
    sound.stop()
    releaseCurrentNarration()
    startNext()
  }

  window.setInterval(() => {
    const now = Date.now()
    // 描画が間引かれていても、音を止めて次へ進めるよう、ここでも終わりを確かめる
    finishIfDone(now)
    if (playback === null) return
    recordVisitIfDue(playback, now)
    for (const cue of dueSoundCues(playback, now, played)) {
      played.add(cue.id)
      sound.play(cue)
      if (cue.type === 'bgmStart') duckStreamBgm(playback)
    }
  }, TOWN_TOUR_SOUND_TICK_MS)

  const draw = startCanvasSurface(canvas, (ctx, width, height) => {
    if (renderer === null) return
    const now = Date.now()
    finishIfDone(now)
    renderer.render(ctx, width, height, playback === null ? null : { playback, scene: sceneAt(playback, now), image, icon })
  })

  if (demo) {
    // プレビューではWorkerにつながず、決まった1件をくり返し流す（紹介も作らせず、作らせたときと同じくらい待ってから届いたことにする）
    startSampleCycle([demoTownTourCall], DEMO_TOWN_TOUR_INTERVAL_MS, enqueue)
    return { draw }
  }

  connectSocket(
    socketUrl(TOWN_TOUR_SOCKET_PATH, { key }),
    {
      onMessage: (text) => {
        try {
          const message = parseTownTourMessage(text)
          if (message.type === 'call') enqueue(message.call)
          else acceptAnswer(message.quizId, message.userName)
        } catch (error) {
          showError(error, NOUNS.townTour, box, 'read')
        }
      },
      onOpen: () => {
        // 呼び出しは押し出しでしか届かない（読み直すものを持たない）。つながっていない間の呼び出しは配送先が落とす
      },
      onStatus: () => {
        // 切断・再接続は出さない。流している1件はそのまま流しきる
      },
      onWarning: (message) => showError(new Error(message), NOUNS.townTour, box, 'read'),
    },
    TOWN_TOUR_SOCKET_HINT,
  )

  return { draw }
}

/**
 * ツイスター（issue #272）。レイドした人と配信者が、three.js の3Dの人形でツイスターゲームをする。
 *
 * Worker から押し出された呼び出し（種と2人の名前・アイコン）を届いた順に1件ずつ流す。対戦の中身（指示・倒れ方・勝敗）は
 * 種から計算し（src/twister/game.ts。倒れ込みの物理も流しはじめる前に計算しておく）、場面と姿勢は再生を始めてからの経過時間だけから決める。
 * 2人のアイコンは流しはじめる前に読み込む。読み込めなかった人は失敗をこの箱に出し、名前の頭文字の顔で流す（対戦は止めない）。
 * 種から対戦を計算できなかった1件は、失敗をこの箱に出して次へ進む。
 *
 * 3Dは WebGL の canvas に、名札・スピナー・文言はその上の2Dの canvas に描く（src/twister/view.ts）。
 */
const mountTwister = (box: HTMLElement, item: OverlayItem, { key, demo }: MountContext): MountedItem => {
  // この素材は配信者が決めるパラメータを持たない（何を流すかはレイドと試し再生で決まる）
  parseParams({}, new URLSearchParams(item.params))

  const glCanvas = document.createElement('canvas')
  glCanvas.dataset.twister = 'stage'
  const hudCanvas = document.createElement('canvas')
  hudCanvas.dataset.twister = 'hud'
  box.append(glCanvas, hudCanvas)
  const renderer = createTwisterRenderer(glCanvas)
  const bgmApi = createBgmOverlayApi(callWorker, key)
  /** 配信の BGM を holdMs ミリ秒下げておくよう裏方へ知らせる（0 は戻す）。プレビューでは配信の BGM を動かさないので送らない */
  const duckStreamBgm = (holdMs: number): void => {
    if (demo) return
    bgmApi.duck(holdMs).catch((error: unknown) => showError(error, NOUNS.twister, box, 'read'))
  }
  // 対戦の BGM を鳴らせなかったら、配信の BGM を対戦の終わりまで下げたままにせず、すぐ戻す
  const bgm = createTwisterBgmPlayer((error) => {
    showError(error, NOUNS.twister, box, 'read')
    duckStreamBgm(0)
  })

  /** 流している1件。流していなければ null */
  let playback: { readonly call: TwisterCall; readonly game: Game; readonly startedAt: number } | null = null
  /** 流すのを待っている呼び出し（届いた順） */
  let waiting: readonly TwisterCall[] = []
  /** 次の1件のアイコンを読み込んでいる最中か */
  let preparing = false

  /** 流していなければ、待っている呼び出しの先頭を準備して流しはじめる */
  const startNext = (): void => {
    if (playback !== null || preparing) return
    const [call, ...rest] = waiting
    if (call === undefined) return
    waiting = rest
    clearError(box, 'read')
    const game = ((): Game | null => {
      try {
        return createGame(call.seed)
      } catch (error) {
        showError(error, NOUNS.twister, box, 'read')
        return null
      }
    })()
    if (game === null) {
      startNext()
      return
    }
    preparing = true
    const loadFace = async (iconUrl: string | null): Promise<HTMLImageElement | null> => {
      if (iconUrl === null) return null
      try {
        return await loadFaceImage(iconUrl)
      } catch (error) {
        showError(error, NOUNS.twister, box, 'read')
        return null
      }
    }
    void Promise.all([loadFace(call.players[0].iconUrl), loadFace(call.players[1].iconUrl)])
      .then((faces) => {
        renderer.setFaces(call, faces)
        playback = { call, game, startedAt: Date.now() }
        const plan = twisterBgmPlanOf(call.sound, game.totalMs)
        if (plan !== null) {
          duckStreamBgm(plan.duckHoldMs)
          bgm.start(plan)
        }
      })
      .catch((error: unknown) => {
        // 顔を作れなかった1件は流さず、失敗を出して次へ進む（待っている呼び出しを止めない）
        showError(error, NOUNS.twister, box, 'read')
      })
      .finally(() => {
        preparing = false
        if (playback === null) startNext()
      })
  }

  const enqueue = (call: TwisterCall): void => {
    waiting = [...waiting, call]
    startNext()
  }

  const draw = startCanvasSurface(hudCanvas, (ctx, width, height) => {
    ctx.clearRect(0, 0, width, height)
    const now = Date.now()
    if (playback !== null && now - playback.startedAt >= playback.game.totalMs) {
      playback = null
      startNext()
    }
    const elapsedMs = playback === null ? 0 : now - playback.startedAt
    renderer.render(ctx, width, height, playback === null ? null : { call: playback.call, scene: gameSceneAt(playback.game, elapsedMs), elapsedMs })
  })

  if (demo) {
    // プレビューではWorkerにつながず、決まった呼び出しを順にくり返し流す
    startSampleCycle(DEMO_TWISTER_CALLS, DEMO_TWISTER_INTERVAL_MS, enqueue)
    return { draw }
  }

  connectSocket(
    socketUrl(TWISTER_SOCKET_PATH, { key }),
    {
      onMessage: (text) => {
        try {
          enqueue(parseTwisterCall(text))
        } catch (error) {
          showError(error, NOUNS.twister, box, 'read')
        }
      },
      onOpen: () => {
        // 呼び出しは押し出しでしか届かない（読み直すものを持たない）。つながっていない間の呼び出しは配送先が落とす
      },
      onStatus: () => {
        // 切断・再接続は出さない。流している1件はそのまま流しきる
      },
      onWarning: (message) => showError(new Error(message), NOUNS.twister, box, 'read'),
    },
    TWISTER_SOCKET_HINT,
  )

  return { draw }
}

/**
 * 漢字クイズ（issue #300）。チャンネルポイントの交換で出題された熟語の読みを問う。
 *
 * Worker から押し出された出題（問題1問と交換した人）を届いた順に1件ずつ流す。場面（級→熟語が奥から近づく→制限時間→正解と解説）は
 * 流しはじめてからの経過時間と、正解者が届いた時刻だけから決め（src/kanji-quiz/scene.ts）、canvas 1枚に描く（src/kanji-quiz/view.ts）。
 * 流しはじめたら Worker に出題を開かせ（POST /api/overlay/kanji-quiz/open）、熟語が出てから制限時間のうちに届いた最初の正解者を出す
 * （届いた時刻でカウントダウンを止める。issue #301）。時間切れの後に届いた正解者は出さない。
 * 時間切れで配信を止めるまでの猶予が届いたら、解説に重ねて配信終了までの残り秒数を出し、取り消し・猶予の終わりの結果を出し終えるまで延ばす（issue #302）。
 *
 * 注意: 出題を開けなかった・選べる問題が尽きた（Worker からの失敗の知らせ）ときは、素材の箱に出す（黙って流し続けない）。
 */
const mountKanjiQuiz = (box: HTMLElement, item: OverlayItem, { key, demo }: MountContext): MountedItem => {
  // この素材は配信者が決めるパラメータを持たない（何を出すかはトリガーと試し再生で決まる）
  parseParams({}, new URLSearchParams(item.params))

  const canvas = document.createElement('canvas')
  canvas.dataset.kanjiQuiz = ''
  box.append(canvas)

  const api = createKanjiQuizApi(callWorker, key)
  /** 流している1件。流していなければ null。answer は最初の正解者と、流しはじめてから届くまでの経過時間。stop は配信を止めるまでの猶予 */
  let playback: {
    readonly call: KanjiQuizCall
    readonly startedAt: number
    readonly answer: { readonly userName: string; readonly afterMs: number } | null
    readonly stop: KanjiQuizStop | null
  } | null = null
  /** 流すのを待っている出題（届いた順） */
  let waiting: readonly KanjiQuizCall[] = []

  const enqueue = (call: KanjiQuizCall): void => {
    waiting = [...waiting, call]
  }

  /** 流している出題の正解者が届いたら、届いた時刻を記録する（最初の1人だけ。熟語が出てから制限時間のうちだけ受け入れる） */
  const acceptAnswer = (quizId: string, userName: string): void => {
    if (playback === null || playback.call.id !== quizId || playback.answer !== null) return
    const afterMs = Date.now() - playback.startedAt
    if (!acceptsAnswerAt(afterMs)) return
    playback = { ...playback, answer: { userName, afterMs } }
  }

  /** 流している出題の、配信を止めるまでの猶予が届いたら、届いた時刻を記録する（流し終えた出題の猶予は出さない。止める判断は Worker が持つ） */
  const acceptStopping = (quizId: string, graceMs: number, rehearsal: boolean): void => {
    if (playback === null || playback.call.id !== quizId || playback.stop !== null) return
    playback = { ...playback, stop: { announcedAfterMs: Date.now() - playback.startedAt, graceMs, rehearsal, cancelledAfterMs: null } }
  }

  /** 流している出題の、配信の停止の取り消しが届いたら、届いた時刻を記録する */
  const acceptStopCancelled = (quizId: string): void => {
    if (playback === null || playback.call.id !== quizId || playback.stop === null || playback.stop.cancelledAfterMs !== null) return
    playback = { ...playback, stop: { ...playback.stop, cancelledAfterMs: Date.now() - playback.startedAt } }
  }

  const draw = startCanvasSurface(canvas, (ctx, width, height) => {
    const now = Date.now()
    if (playback !== null && now - playback.startedAt >= kanjiQuizEndOf(playback.answer?.afterMs ?? null, playback.stop)) playback = null
    // 流していなければ、待っている出題の先頭を流しはじめる
    if (playback === null) {
      const [next, ...rest] = waiting
      if (next !== undefined) {
        waiting = rest
        playback = { call: next, startedAt: now, answer: null, stop: null }
        // プレビューは Worker の選んだ出題ではないので開かせない
        if (!demo) {
          // 開けなければ回答が届かないまま時間切れまで流れるので、理由を箱に出す（次の出題の読み取りが届けば消す）
          api.openQuiz(next.id).catch((error: unknown) => showError(error, NOUNS.kanjiQuiz, box, 'read'))
        }
      }
    }
    drawKanjiQuiz(
      ctx,
      width,
      height,
      playback === null
        ? null
        : {
            call: playback.call,
            scene: kanjiQuizSceneAt(now - playback.startedAt, playback.answer?.afterMs ?? null, playback.stop),
            winnerName: playback.answer?.userName ?? null,
            stopBanner: kanjiQuizStopBannerAt(now - playback.startedAt, playback.stop),
          },
    )
  })

  if (demo) {
    // プレビューではWorkerにつながず、決まった出題を順にくり返し流す
    startSampleCycle(DEMO_KANJI_QUIZ_CALLS, DEMO_KANJI_QUIZ_INTERVAL_MS, enqueue)
    return { draw }
  }

  connectSocket(
    socketUrl(KANJI_QUIZ_SOCKET_PATH, { key }),
    {
      onMessage: (text) => {
        try {
          const message = parseKanjiQuizMessage(text)
          if (message.type === 'call') {
            // 次の出題が届いたら、前の失敗（読み取り・開けなかった・出しきった）の表示を消す
            clearError(box, 'read')
            enqueue(message.call)
          } else if (message.type === 'answer') acceptAnswer(message.quizId, message.userName)
          else if (message.type === 'stopping') acceptStopping(message.quizId, message.graceMs, message.rehearsal)
          else if (message.type === 'stopCancelled') acceptStopCancelled(message.quizId)
          else showError(new Error(message.message), NOUNS.kanjiQuiz, box, 'read')
        } catch (error) {
          showError(error, NOUNS.kanjiQuiz, box, 'read')
        }
      },
      onOpen: () => {
        // 出題は押し出しでしか届かない（読み直すものを持たない）。つながっていない間の出題は配送先が落とす
      },
      onStatus: () => {
        // 切断・再接続は出さない。流している1件はそのまま流しきる
      },
      onWarning: (message) => showError(new Error(message), NOUNS.kanjiQuiz, box, 'read'),
    },
    KANJI_QUIZ_SOCKET_HINT,
  )

  return { draw }
}

/**
 * テキスト。配信者が書いた文字のうち、パラメータで選んだ1件を札に出す（issue #294）。
 *
 * テキストの一覧は追加・書き換え・削除のたびにアラートと同じ配送先から WebSocket（/api/overlay/texts/socket）で丸ごと押し出してもらい、
 * 開いたとき・つながるたび・定期的に読み直す。届くたびに、選んだテキストをIDで引き直して映す。
 * 読んでいるあいだに押し出しが届いたら、読んだ結果も読み出しの失敗も捨てる（作業机と同じ。押し出しのほうが新しい）。
 *
 * 注意: 選んでいない・選んだテキストが消された場合は、札を隠して箱にエラーを出す（黙って空にしない。方針4）。
 */
const mountText = (box: HTMLElement, item: OverlayItem, { key, demo }: MountContext): MountedItem => {
  const params = parseParams(textParamSchema, new URLSearchParams(item.params))

  const root = document.createElement('div')
  root.className = 'text'
  root.dataset.text = ''
  box.append(root)

  const view = createTextView(root, { frame: params.frame, overflow: params.overflow })
  // 縮める・流すは要素の大きさを測って決めるので、箱の大きさが変わったとき・フォントが読み終わったときに測り直す
  new ResizeObserver(() => view.refit()).observe(box)
  void document.fonts.ready.then(() => view.refit())
  // 札を出したあとに読み込みが始まったフォント（後から使われた字形など）でも測り直す
  document.fonts.addEventListener('loadingdone', () => view.refit())

  if (demo) {
    // プレビューではWorkerにつながず、選んだテキストに関わらずサンプルの本文を順に流す
    startSampleCycle(demoTexts, DEMO_SAMPLE_INTERVAL_MS, (text) => view.show(text))
    return {}
  }

  const showReadError = (error: unknown): void => {
    clearError(box, 'read')
    showError(error, NOUNS.text, box, 'read')
  }
  /**
   * 届いた一覧から選んだテキストを引いて映す。見つからなければ札を隠して箱にエラーを出す。
   *
   * 読み出しの失敗と同じ出どころ（read）に出すので、次に映せたときに一緒に消える。
   */
  const show = (texts: readonly TextEntry[]): void => {
    try {
      const text = textToShow(texts, params.text)
      // 隠したままでは本文の大きさを測れないので、見せてから映す（縮める・流すの計算を正しくするため）
      root.hidden = false
      view.show(text)
      clearError(box, 'read')
    } catch (error) {
      root.hidden = true
      showReadError(error)
    }
  }
  /** いちばん新しく始めた読み出しの世代。重なった読み出しのうち、古いものの結果で新しい一覧を上書きしないために使う */
  let latestRead = 0
  /** 押し出しを受け取った回数。読んでいるあいだに押し出しが届いたかを見分けるために使う */
  let pushCount = 0
  const api = createTextOverlayApi(callWorker, key)
  /**
   * 一覧を読み直す。失敗は onError に渡すが、あとから始めた読み出しや押し出しに追い越されていれば捨てる。
   *
   * @param onError 追い越されていない失敗の扱い（箱に出す・記録に残すだけ、を呼び出し側が決める）
   */
  const read = async (onError: (error: unknown) => void): Promise<void> => {
    latestRead += 1
    const generation = latestRead
    const pushCountAtStart = pushCount
    const isStale = (): boolean => generation !== latestRead || pushCountAtStart !== pushCount
    try {
      const texts = await api.read()
      if (isStale()) return
      show(texts)
    } catch (error) {
      if (!isStale()) onError(error)
    }
  }

  // 1回目は起動の一部として扱い、失敗はこの箱に出す（ほかの素材は動かし続ける）
  void read(showReadError)

  connectSocket(
    socketUrl(TEXT_SOCKET_PATH, { key }),
    {
      onMessage: (message) => {
        try {
          const texts = parseTextsMessage(message)
          pushCount += 1
          show(texts)
        } catch (error) {
          showReadError(error)
        }
      },
      // つながるたびに読み直す。つながっていない間の書き換えを取りこぼさないため
      onOpen: () => void read(showReadError),
      onStatus: () => {
        // 切断・再接続は出さない。つながったときの読み直しは onOpen が受け持ち、映している札はそのまま残す
      },
      onWarning: (message) => showReadError(new Error(message)),
    },
    TEXT_SOCKET_HINT,
  )

  return {
    task: {
      intervalMs: TEXT_INTERVAL_MS,
      run: () => {
        void read((error) => {
          // 一時的な通信の失敗で配信画面を汚さない。映している札はそのまま残し、原因は記録に残す（作業机と同じ）
          console.error('テキストを読み込めませんでした', error)
        })
      },
    },
  }
}

/**
 * 意見ボード。配信者が出したテーマについて、視聴者のコメントから取り出した意見を論点ごとに並べる（issue #306）。
 *
 * 意見ボードはテーマを開いた・締め切った・振り分けた・意見を隠したたびに、アラートと同じ配送先から WebSocket（/api/overlay/opinions/socket）で
 * 丸ごと押し出してもらい、開いたとき・つながるたび・定期的に読み直す。読んでいるあいだに押し出しが届いたら、読んだ結果も
 * 読み出しの失敗も捨てる（作業机と同じ。押し出しのほうが新しい）。中央の「いま紹介している意見」と作ったばかりの印は、
 * 毎フレーム現在時刻から決める（src/opinions/entry.ts）。
 */
const mountOpinions = (box: HTMLElement, item: OverlayItem, { key, demo }: MountContext): MountedItem => {
  // この素材は配信者が決めるパラメータを持たない（映すものはテーマとコメントで決まる）
  parseParams({}, new URLSearchParams(item.params))

  const root = document.createElement('div')
  root.className = 'opinions'
  root.dataset.opinions = ''
  box.append(root)

  const view = createOpinionView(root)
  const draw = (): void => view.draw(Date.now())

  if (demo) {
    // プレビューではWorkerにつながず、意見が増えていく場面を順に流す
    startSampleCycle(demoOpinionBoards, DEMO_SAMPLE_INTERVAL_MS, (board) => view.setBoard(board))
    return { draw }
  }

  const api = createOpinionOverlayApi(callWorker, key)
  const showReadError = (error: unknown): void => {
    clearError(box, 'read')
    showError(error, NOUNS.opinions, box, 'read')
  }
  const show = (board: OpinionBoard): void => {
    view.setBoard(board)
    // 最新の意見ボードを映せたので、前の失敗が箱に出ていれば消す
    clearError(box, 'read')
  }
  /** いちばん新しく始めた読み出しの世代。重なった読み出しのうち、古いものの結果で新しい意見ボードを上書きしないために使う */
  let latestRead = 0
  /** 押し出しを受け取った回数。読んでいるあいだに押し出しが届いたかを見分けるために使う */
  let pushCount = 0
  /**
   * 意見ボードを読み直す。失敗は onError に渡すが、あとから始めた読み出しや押し出しに追い越されていれば捨てる。
   *
   * @param onError 追い越されていない失敗の扱い（箱に出す・記録に残すだけ、を呼び出し側が決める）
   */
  const read = async (onError: (error: unknown) => void): Promise<void> => {
    latestRead += 1
    const generation = latestRead
    const pushCountAtStart = pushCount
    const isStale = (): boolean => generation !== latestRead || pushCountAtStart !== pushCount
    try {
      const board = await api.read()
      if (isStale()) return
      show(board)
    } catch (error) {
      if (!isStale()) onError(error)
    }
  }

  // 1回目は起動の一部として扱い、失敗はこの箱に出す（ほかの素材は動かし続ける）
  void read(showReadError)

  connectSocket(
    socketUrl(OPINION_SOCKET_PATH, { key }),
    {
      onMessage: (message) => {
        try {
          const board = parseOpinionBoardMessage(message)
          pushCount += 1
          show(board)
        } catch (error) {
          showReadError(error)
        }
      },
      // つながるたびに読み直す。つながっていない間の変化を取りこぼさないため
      onOpen: () => void read(showReadError),
      onStatus: () => {
        // 切断・再接続は出さない。つながったときの読み直しは onOpen が受け持ち、映している意見ボードはそのまま残す
      },
      onWarning: (message) => showReadError(new Error(message)),
    },
    OPINION_SOCKET_HINT,
  )

  return {
    draw,
    task: {
      intervalMs: OPINIONS_INTERVAL_MS,
      run: () => {
        void read((error) => {
          // 一時的な通信の失敗で配信画面を汚さない。映している意見ボードはそのまま残し、原因は記録に残す（作業机と同じ）
          console.error('意見ボードを読み込めませんでした', error)
        })
      },
    },
  }
}

const mountItem = (box: HTMLElement, item: OverlayItem, context: MountContext): MountedItem => {
  switch (item.kind) {
    case 'wallpaper':
    case 'clock':
      return mountCanvasMaterial(box, item)
    case 'chat':
      return mountChat(box, item, context)
    case 'alerts':
      return mountAlerts(box, item, context)
    case 'sideSuper':
      return mountSideSuper(box, item, context)
    case 'focus':
      return mountFocus(box, item, context)
    case 'draw':
      return mountDraw(box, item, context)
    case 'bgm':
      return mountBgm(box, item, context)
    case 'tab':
      return mountTab(box, item, context)
    case 'caption':
      return mountCaption(box, item, context)
    case 'workLog':
      return mountWorkLog(box, item, context)
    case 'taskDesk':
      return mountTaskDesk(box, item, context)
    case 'pomodoro':
      return mountPomodoro(box, item, context)
    case 'townTour':
      return mountTownTour(box, item, context)
    case 'twister':
      return mountTwister(box, item, context)
    case 'wipe':
      return mountWipe(box, item, context)
    case 'text':
      return mountText(box, item, context)
    case 'kanjiQuiz':
      return mountKanjiQuiz(box, item, context)
    case 'opinions':
      return mountOpinions(box, item, context)
  }
}

/**
 * プレビューとして開かれたときに、映す構成を親の窓（管理画面）から受け取る。
 *
 * Worker から読まないのは、保存はその時点で配信画面へ反映されるためである（保存してからでないと
 * 確かめられないプレビューでは意味が無い。issue #106）。待つ側から先に「構成を待っている」と
 * 知らせるのは、iframe の読み込みが終わる時期を親からは決められないためである。
 *
 * @throws 親の窓が無い（プレビューとして開かれていない）・構成が届かない・構成の形が違う場合
 */
const receivePreviewLayout = async (): Promise<readonly Overlay[]> =>
  new Promise((resolve, reject) => {
    if (window.parent === window) {
      reject(new Error('プレビューは管理画面（/overlay/）から開いてください（構成は親の画面から受け取ります）'))
      return
    }

    const stop = (): void => {
      window.removeEventListener('message', onMessage)
      window.clearTimeout(timer)
    }

    function onMessage(event: MessageEvent): void {
      // 構成にはこの配信の素材の並びが入るので、同じサイトの窓からの知らせだけを読む
      if (event.origin !== location.origin) return
      try {
        const overlays = readPreviewLayout(event.data)
        // 自分たちの知らせでなければ（開発サーバーの再読み込みなど）そのまま待ち続ける
        if (overlays === undefined) return
        stop()
        resolve(overlays)
      } catch (error) {
        stop()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }

    const timer = window.setTimeout(() => {
      stop()
      reject(new Error('管理画面から構成が届きませんでした（プレビューを開き直してください）'))
    }, PREVIEW_WAIT_MS)

    window.addEventListener('message', onMessage)
    window.parent.postMessage(previewReadyMessage(), location.origin)
  })

/**
 * オーバーレイで1本の描画ループを回す。
 *
 * 描画中に投げた素材は、その箱に失敗を出して一覧から外す（毎フレーム同じ失敗を出さないため）。
 * ほかの素材の描画は続ける。
 */
const startDrawLoop = (items: DrawingItem[]): void => {
  const loop = (elapsedMs: number): void => {
    for (const item of [...items]) {
      try {
        item.draw(elapsedMs)
      } catch (error) {
        items.splice(items.indexOf(item), 1)
        showError(error, item.noun, item.box)
      }
    }
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
}

/** オーバーレイで1本のタイマーで、読みに行くものをそれぞれの間隔で回す */
const startPolling = (tasks: readonly PollTask[]): void => {
  if (tasks.length === 0) return
  const tickMs = pollTickMs(tasks)
  let tick = 0
  window.setInterval(() => {
    tick += 1
    for (const task of dueTasks(tasks, tickMs, tick)) task.run()
  }, tickMs)
}

const start = async (): Promise<void> => {
  const root = document.querySelector<HTMLElement>('[data-overlay]')
  if (!root) throw new Error('data-overlay 属性を持つ要素が見つかりません')

  const params = parseParams(schema, new URLSearchParams(location.search))
  if (!params.demo && params.key === '') {
    throw new ParamError(['key: オーバーレイ用キーを指定してください（例: ?key=<キー>&overlay=front）'])
  }

  // 構成の受け取りは起動の一部。ここで失敗したらこのオーバーレイには何も描けないので、ページ全体に出す。
  // プレビュー（?demo=true）では編集中の構成を親の窓から受け取り、ふだんは Worker から読む
  const all = params.demo ? await receivePreviewLayout() : await createOverlayLayoutApi(callWorker, params.key).read()
  const items = itemsInOverlay(all, params.overlay)
  if (items.length === 0) {
    const overlayNames = overlayNamesOf(all)
    throw new Error(
      `オーバーレイ「${params.overlay}」に素材がありません（構成にあるオーバーレイ: ${overlayNames.length > 0 ? overlayNames.join('・') : 'なし'}）`,
    )
  }

  const hub = createChatHub()
  const context: MountContext = { key: params.key, demo: params.demo, hub }
  const drawing: DrawingItem[] = []
  const tasks: PollTask[] = []
  /** チャットの受け取りを使う素材の箱。つなげなかったときに、そこへ失敗を出す */
  const chatBoxes: HTMLElement[] = []

  // 箱は構成の並びの順に置く（あとのものが前に重なる）
  for (const item of items) {
    const box = document.createElement('div')
    box.className = 'overlay-item'
    box.dataset.item = item.kind
    Object.assign(box.style, rectStyle(item.rect))
    root.append(box)

    const noun = NOUNS[item.kind]
    try {
      const mounted = mountItem(box, item, context)
      if (mounted.draw) drawing.push({ box, noun, draw: mounted.draw })
      if (mounted.task) tasks.push(mounted.task)
      if (mounted.usesChat) chatBoxes.push(box)
    } catch (error) {
      // 1つの素材の失敗で同じオーバーレイのほかの素材を止めない（issue #101 で決めた例外）
      showError(error, noun, box)
    }
  }

  startDrawLoop(drawing)
  startPolling(tasks)

  if (chatBoxes.length > 0) {
    await hub.start().catch((error: unknown) => {
      // チャンネル名が読めないと発言が届かないので、チャットを使う素材それぞれに理由を出す
      for (const box of chatBoxes) showError(error, NOUNS.chat, box, 'chat')
    })
  }
}

// 構成の読み出しを待つため、起動は非同期になる。失敗は同期・非同期のどちらも画面に出す
start().catch((error: unknown) => {
  showError(error, NOUN)
  throw error
})
