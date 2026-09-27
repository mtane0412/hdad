/**
 * 合成オーバーレイ（overlay/stage/index.html）のエントリスクリプト
 *
 * OBSのブラウザソースはその数だけ Chromium のレンダラを立ち上げるため、素材ごとにページを分けると
 * 配信中のメモリを食う。そこで素材を「レイヤー」として1枚のページに重ね、ブラウザソースは「段」（group）
 * ごとに1つだけ置く（issue #101）。どの段にどの素材をどこへ置くかは Worker が持つ構成（KVの
 * overlay-layout）で決まるので、OBSに貼るURLは ?key=（オーバーレイ用キー）と ?group=（段の名前）だけで、
 * 一度貼ったら変わらない。
 *
 * 段を分けるのは、アバターやゲーム画面というWebでないソースが間に挟まり、Web側の素材をその前と後ろの
 * 両方に置きたいためである。構成の読み出しは api.ts、段の絞り込みと箱の位置は layout.ts、
 * ポーリングの束ね方は poll.ts にあり、ここはそれらをつないでDOMとWebSocketを扱う。
 *
 * まとめることで減るものを、次の3つの決まりで守る。
 * - レイヤーごとに canvas を1枚持ち、1枚の全画面 canvas へ合成しない（まとめたのに重くならないため。
 *   小さく置いた時計が全画面ぶんの描画面積を持ってしまう）
 * - requestAnimationFrame は段で1本にし、そのループの中で各レイヤーの描画を順に呼ぶ
 * - 同じ段のレイヤーは接続を共有する（匿名IRCは1本、チャンネル名とバッジ・Cheermote の取得も1回、
 *   ポーリングは1つのタイマー）
 *
 * 注意: 1つのレイヤーの失敗で、同じ段のほかのレイヤーは動かし続ける（issue #101 で決めた、Fail-Fast に
 * 意識して設けた例外）。理由は「配信中に片方が壊れたときの被害を、配信画面の全損から1レイヤーの欠落に
 * 留めるため」で、失敗はそのレイヤーの箱の中だけに表示する。
 * 注意: 素材ページの約束どおり、React もログインも持ち込まない。
 */
import { EMPTY_QUEUE, advance, enqueue } from '../alerts/queue'
import { connectAlerts } from '../alerts/socket'
import { createAlertView } from '../alerts/view'
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
import { clearError, findDefinition, showError, startCanvasLayer, type DrawFrame } from '../core/mount'
import { ParamError, parseParams, type ParamSchema } from '../core/params'
import { createFocusOverlayApi } from '../focus/api'
import { NO_FOCUS, withMessage, withRemoval, withTarget, type FocusState } from '../focus/focused'
import { createFocusView } from '../focus/view'
import { createSideSuperApi } from '../side-super/api'
import { sideSuperParamSchema } from '../side-super/params'
import { createSideSuperView } from '../side-super/view'
import { backgrounds } from '../wallpaper/registry'
import { createOverlayLayoutApi } from './api'
import { groupsOf, layersInGroup, rectStyle, type LayerKind, type OverlayLayer } from './layout'
import { dueTasks, pollTickMs, type PollInterval } from './poll'

/** ページ全体の失敗（構成が読めない・段が空）でエラー表示に使う呼び名 */
const NOUN = 'オーバーレイ'

/** レイヤーの失敗を表示するときに素材を指す呼び名 */
const NOUNS: Readonly<Record<LayerKind, string>> = {
  wallpaper: '背景',
  clock: '時計',
  chat: 'チャットボックス',
  alerts: 'アラート',
  sideSuper: 'サイドスーパー',
  focus: '注目コメント',
}

/** サイドスーパーの文言を読みに行く間隔（ミリ秒）。src/side-super/stage.ts と同じ理由で30秒 */
const SIDE_SUPER_INTERVAL_MS = 30000
/** 取り上げている注目コメントを読みに行く間隔（ミリ秒）。src/focus/stage.ts と同じ理由で10秒 */
const FOCUS_INTERVAL_MS = 10000

const schema = {
  key: {
    type: 'string',
    default: '',
    // Workerが発行するキー（worker/secret.ts の randomToken）は、URLにそのまま載せられる文字だけでできている
    pattern: /^[A-Za-z0-9_-]{32,}$/,
    example: '管理用API（/api/me）の overlayKey の値',
    description: 'オーバーレイ用キー（必須）',
  },
  group: {
    type: 'string',
    default: 'front',
    // 段の名前の書式は worker/overlay-layout.ts の GROUP_PATTERN と合わせる
    pattern: /^[a-z0-9-]{1,20}$/,
    example: 'back または front',
    description: '描く段の名前（この段に置いたレイヤーだけを重ねる）',
  },
} as const satisfies ParamSchema

// fetch をそのまま渡すと this が外れて Illegal invocation になるブラウザがあるので、包んで渡す
const callWorker: typeof fetch = (input, init) => fetch(input, init)

/** 描画を続けるレイヤー1つ。描画中に投げたら、その箱にだけ失敗を出して一覧から外す */
interface DrawingLayer {
  readonly box: HTMLElement
  readonly noun: string
  readonly draw: DrawFrame
}

/** 読みに行くもの1つ（段で1本のタイマーが回す） */
interface PollTask extends PollInterval {
  run(): void
}

/**
 * 同じ段のチャットの受け取りをまとめる。
 *
 * チャットボックスと注目コメントを同じ段に置いても、匿名IRCの接続・チャンネル名の取得・公式バッジと
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

  /** 登録された相手に、システムからのお知らせとして1行伝える（出す場所を持たないレイヤーは捨てる） */
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
    /** このレイヤーが要るものを伝える（要らないものはWorkerにも取りに行かない） */
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
     * Cheermote を先に取り出してから、残った文字をエモートとして置き換える（チャットボックスの
     * 単独ページと同じ順序）。サードパーティエモートは、それを要求したレイヤーにだけ当てる。
     */
    decorate(message: ChatMessage, thirdparty: boolean): ChatMessage {
      const fragments = applyCheermotes(message.fragments, cheermotes, message.bits)
      return { ...message, fragments: thirdparty ? applyEmotes(fragments, thirdPartyEmotes) : fragments }
    },

    /**
     * 接続先を取得してつなぐ。登録がすべて済んだあとに1回だけ呼ぶ。
     *
     * @throws チャンネル名を取得できなかった場合（呼び出し側が、チャットを使うレイヤーの箱に出す）
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

/** レイヤーを起動した結果。描くもの・読みに行くものがあれば返す */
interface MountedLayer {
  readonly draw?: DrawFrame
  readonly task?: PollTask
  /** チャットの受け取りを使うか（つなげなかったときに、この箱へ失敗を出す） */
  readonly usesChat?: boolean
}

/** 壁紙・時計。箱の中に canvas を1枚置き、1フレームぶんの描画を受け取る */
const mountCanvasMaterial = (box: HTMLElement, layer: OverlayLayer): MountedLayer => {
  const definitions = layer.kind === 'wallpaper' ? backgrounds : clocks
  const definition = findDefinition(definitions, layer.id, NOUNS[layer.kind])
  const canvas = document.createElement('canvas')
  // 単独ページと同じく、何を描いている canvas かを属性に残す（開発者ツールで追えるようにする）
  canvas.dataset[layer.kind === 'wallpaper' ? 'background' : 'clock'] = definition.id
  box.append(canvas)
  return { draw: startCanvasLayer(canvas, definition, new URLSearchParams(layer.params)) }
}

/** チャットボックス。デザインのCSSは [data-chat='<id>'] で効くので、箱の中の ol に属性を持たせる */
const mountChat = (box: HTMLElement, layer: OverlayLayer, hub: ChatHub): MountedLayer => {
  const definition = chats.find((candidate) => candidate.id === layer.id)
  if (!definition) throw new Error(`${NOUNS.chat}「${layer.id}」はレジストリに登録されていません`)

  const root = document.createElement('ol')
  root.className = 'chat'
  root.dataset.chat = definition.id
  box.append(root)

  const params = parseParams(definition.schema, new URLSearchParams(layer.params))
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
const mountAlerts = (box: HTMLElement, layer: OverlayLayer, key: string): MountedLayer => {
  // このレイヤーは配信者が決めるパラメータを持たない（空でないクエリは誤りとして知らせる）
  parseParams({}, new URLSearchParams(layer.params))

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

  connectAlerts(key, {
    onAlert: (alert) => {
      // 前回の失敗のお知らせが残っていれば消す
      view.setNotice(null)
      const idle = queue.current === null
      queue = enqueue(queue, alert)
      if (idle) play()
    },
    onStatus: (status) => view.setNotice(status === 'disconnected' ? 'Workerとの接続が切れました。再接続します…' : null),
    onWarning: (message) => view.setNotice(message),
  })
  return {}
}

/** サイドスーパー。cron が作った文言を定期的に読みに行って映す */
const mountSideSuper = (box: HTMLElement, layer: OverlayLayer, key: string): MountedLayer => {
  const params = parseParams(sideSuperParamSchema, new URLSearchParams(layer.params))

  const root = document.createElement('div')
  root.className = 'side-super'
  root.dataset.sideSuper = ''
  // 寄せる向きはCSS（src/side-super/side-super.css）が data-position から決める
  root.dataset.position = params.position
  box.append(root)

  const view = createSideSuperView(root)
  const api = createSideSuperApi(callWorker, key)
  const read = async (): Promise<void> => {
    view.setLines(await api.read())
    // 前の読み出しの失敗が箱に出ていれば消す（直ったのに赤い表示が残ったままにしない）。
    // 消すのは読み出しの失敗だけで、チャットの接続の失敗は読み直しでは直らないので残す
    clearError(box, 'read')
  }

  // 1回目は起動の一部として扱い、失敗はこの箱に出す（ほかのレイヤーは動かし続ける）
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
 * 注目コメント。取り上げているものを定期的に読みに行き、人に追従する指定ならIRCで届く発言で差し替える。
 *
 * モデレーターの操作で映しているものが消えたら映すのをやめる（withRemoval）。配信画面に残ったままに
 * すると取り返しがつかないので、発言1件を固定しているあいだもチャットの受け取りを使う。
 */
const mountFocus = (box: HTMLElement, layer: OverlayLayer, key: string, hub: ChatHub): MountedLayer => {
  // このレイヤーは配信者が決めるパラメータを持たない（取り上げる相手は Worker が持つ）
  parseParams({}, new URLSearchParams(layer.params))

  const root = document.createElement('div')
  root.className = 'focus'
  root.dataset.focus = ''
  box.append(root)

  const view = createFocusView(root)
  const api = createFocusOverlayApi(callWorker, key)

  /** いま取り上げているものと、映している1件。ここだけが持ち、書き換えたら必ず画面へ反映する */
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

  // 要るものを伝えないのは、公式バッジもサードパーティエモートも使わないためである
  // （Cheermote は絵で出したいが、これは接続のときに必ず読み込まれる）
  hub.listen({
    onEvent: (event) => {
      switch (event.type) {
        case 'message':
          update(withMessage(state, hub.decorate(event.message, false)))
          break
        case 'delete':
          update(withRemoval(state, { type: 'message', messageId: event.id }))
          break
        case 'clear-user':
          update(withRemoval(state, { type: 'user', login: event.login }))
          break
        case 'clear-all':
          update(withRemoval(state, { type: 'all' }))
          break
        case 'room':
        case 'notice':
          // 接続の知らせは映すものに関係しない（このレイヤーには出す場所が無い）
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

/** レイヤー1つを起動する */
const mountLayer = (box: HTMLElement, layer: OverlayLayer, key: string, hub: ChatHub): MountedLayer => {
  switch (layer.kind) {
    case 'wallpaper':
    case 'clock':
      return mountCanvasMaterial(box, layer)
    case 'chat':
      return mountChat(box, layer, hub)
    case 'alerts':
      return mountAlerts(box, layer, key)
    case 'sideSuper':
      return mountSideSuper(box, layer, key)
    case 'focus':
      return mountFocus(box, layer, key, hub)
  }
}

/**
 * 段で1本の描画ループを回す。
 *
 * 描画中に投げたレイヤーは、その箱に失敗を出して一覧から外す（毎フレーム同じ失敗を出さないため）。
 * ほかのレイヤーの描画は続ける。
 */
const startDrawLoop = (layers: DrawingLayer[]): void => {
  const loop = (elapsedMs: number): void => {
    for (const layer of [...layers]) {
      try {
        layer.draw(elapsedMs)
      } catch (error) {
        layers.splice(layers.indexOf(layer), 1)
        showError(error, layer.noun, layer.box)
      }
    }
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
}

/** 段で1本のタイマーで、読みに行くものをそれぞれの間隔で回す */
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
  if (params.key === '') {
    throw new ParamError(['key: オーバーレイ用キーを指定してください（例: ?key=<キー>&group=front）'])
  }

  // 構成の読み出しは起動の一部。ここで失敗したらこの段には何も描けないので、ページ全体に出す
  const all = await createOverlayLayoutApi(callWorker, params.key).read()
  const layers = layersInGroup(all, params.group)
  if (layers.length === 0) {
    const 段 = groupsOf(all)
    throw new Error(
      `段「${params.group}」にレイヤーがありません（構成にある段: ${段.length > 0 ? 段.join('・') : 'なし'}）`,
    )
  }

  const hub = createChatHub()
  const drawing: DrawingLayer[] = []
  const tasks: PollTask[] = []
  /** チャットの受け取りを使うレイヤーの箱。つなげなかったときに、そこへ失敗を出す */
  const chatBoxes: HTMLElement[] = []

  // 箱は構成の並びの順に置く（あとのものが前に重なる）
  for (const layer of layers) {
    const box = document.createElement('div')
    box.className = 'overlay-layer'
    box.dataset.layer = layer.kind
    Object.assign(box.style, rectStyle(layer.rect))
    root.append(box)

    const noun = NOUNS[layer.kind]
    try {
      const mounted = mountLayer(box, layer, params.key, hub)
      if (mounted.draw) drawing.push({ box, noun, draw: mounted.draw })
      if (mounted.task) tasks.push(mounted.task)
      if (mounted.usesChat) chatBoxes.push(box)
    } catch (error) {
      // 1つのレイヤーの失敗で同じ段のほかのレイヤーを止めない（issue #101 で決めた例外）
      showError(error, noun, box)
    }
  }

  startDrawLoop(drawing)
  startPolling(tasks)

  if (chatBoxes.length > 0) {
    await hub.start().catch((error: unknown) => {
      // チャンネル名が読めないと発言が届かないので、チャットを使うレイヤーそれぞれに理由を出す
      for (const box of chatBoxes) showError(error, NOUNS.chat, box, 'chat')
    })
  }
}

// 構成の読み出しを待つため、起動は非同期になる。失敗は同期・非同期のどちらも画面に出す
start().catch((error: unknown) => {
  showError(error, NOUN)
  throw error
})
