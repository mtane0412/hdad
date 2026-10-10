/**
 * アラートの配送（Durable Object）
 *
 * Twitchからの通知はWebhookでWorkerに届くが、Workerは接続を保持できないため、オーバーレイ（OBSのブラウザソース）へ
 * 自分から知らせる手だてがない。そこで接続を保持できる Durable Object を1つだけ置き、オーバーレイはそこへ
 * WebSocketでつなぎ、Workerは当てはまったアラートをそこへ押し出す。
 *
 * この Durable Object は「配送者」であって「判定者」ではない。どのトリガーに当てはまるかは Worker（alert-event.ts）が決め、
 * ここは受け取ったアラートをそのまま開いている接続へ配るだけである。設定をここに持たせると、
 * 管理画面での変更がOBSの再読み込みなしで反映される性質が壊れる。
 *
 * 接続は Hibernation API（ctx.acceptWebSocket）で受ける。つないだままでも待っている間は課金されないため、
 * 配信中ずっとつなぎっぱなしにできる（無料枠の Duration を使い切らない）。
 * オーバーレイから届く ping には ctx.setWebSocketAutoResponse が起こさずに応える。
 *
 * オーバーレイを開いていない間に届いたアラートは、貯めずに落とす（配信していないときの分が後からまとめて流れないため）。
 *
 * BGMの切り替え（「いま流している曲」）も、この Durable Object が裏方のページ（overlay/backstage/ の ?bgm=true）へ配る
 * （issue #151）。専用の Durable Object を追加しないのは、新しい Durable Object を追加すると PR ブランチの
 * プレビュービルドが失敗するためである。受け取る側の読み取りが違う（合成ページはアラートとしてしか読めない）ので、
 * 接続を受け入れるときに目印（タグ）を付け、アラートはアラートの接続へ、BGMはBGMの接続へだけ配る。
 * どちらの目印で受け入れるかは Worker が決める（手書きの中継 worker/draw-channel.ts と同じ分け方）。
 *
 * 合成ページの素材「作業ログ」へ、開発の出来事と章の見出しを1行ずつ配るのもこの Durable Object である（issue #211）。
 * 理由はBGMと同じで、受け取る素材がアラートと違うので、3つ目の目印（workLog）を付けた接続へだけ配る。
 *
 * 合成ページの素材「作業机」へ、視聴者の作業の宣言（いまの作業机の丸ごと）を配るのもこの Durable Object である（issue #207）。
 * 作業ログと同じ理由で、4つ目の目印（taskDesk）を付けた接続へだけ配る。
 *
 * 合成ページの素材「ポモドーロ」へ、タイマー（始めた時刻・一時停止の時刻。止めたら null）を配るのもこの Durable Object である（issue #208）。
 * 同じ理由で、5つ目の目印（pomodoro）を付けた接続へだけ配る。
 *
 * 合成ページの素材「市町村紹介」へ、引いた市町村と冒頭の一文を配るのもこの Durable Object である（issue #229）。
 * 同じ理由で、6つ目の目印（townTour）を付けた接続へだけ配る。冒頭の都道府県当てクイズの最初の正解者（issue #251）も、
 * 同じ素材が受け取るので同じ接続へ配る（type: answer で呼び出しと見分けさせる）。
 *
 * 市町村紹介のBGMが鳴るあいだ配信のBGMを下げる知らせを、裏方のページへ配るのもこの Durable Object である（issue #245）。
 * 曲の切り替え（bgm）を受け取る素材「再生中の曲」と管理画面は下げる知らせを読まないので、7つ目の目印（bgmDuck）を付けた接続へだけ配る。
 *
 * 読み上げのページ（speech/reader/・裏方のページの ?speech=true）へ、下部バーで切り替えた読み上げのミュートを配るのもこの Durable Object である
 * （issue #238）。同じ理由で、8つ目の目印（speechMute）を付けた接続へだけ配る。
 *
 * 合成ページの素材「ツイスター」へ、対戦の種と2人の名前・アイコンを配るのもこの Durable Object である（issue #272）。
 * 同じ理由で、9つ目の目印（twister）を付けた接続へだけ配る。
 *
 * 合成ページの素材「テキスト」へ、配信者が書いたテキストの一覧（丸ごと）を配るのもこの Durable Object である（issue #294）。
 * 同じ理由で、10個目の目印（text）を付けた接続へだけ配る。
 *
 * 合成ページの素材「漢字クイズ」へ、チャンネルポイントの交換と試し再生での出題（問題1問と交換した人の名前）を配るのもこの Durable Object である（issue #300）。
 * 同じ理由で、11個目の目印（kanjiQuiz）を付けた接続へだけ配る。
 *
 * 漢字クイズの時間切れで配信を止める命令（issue #302）を、裏方のページ（overlay/backstage/ の ?stop=true）へ配るのもこの Durable Object である。
 * 同じ理由で、12個目の目印（streamStop）を付けた接続へ配る。この命令だけは、すべての接続ではなく送れた1つにだけ送り（StopStream を2回送らない）、
 * 受け取る接続が1つも無ければ409を返す
 * （つながっていない間に止める命令を落とすと、配信が止まらなかったことに誰も気づけないため）。
 *
 * 注意: WebSocketの接続（Upgrade）は Cloudflare のランタイムでしか作れないので、テストでは配送の部分だけを確かめる。
 */
import type { OverlayAlert } from './alert-event'
import type { BgmDuck, BgmNowPlaying } from './bgm-config'
import { STATUS, errorResponse } from './http'
import { KEY_TAG_PARAM, isCurrentKeyTag, rememberKeyTag, revokeRequest, type DurableStorage } from './overlay-key'
import { broadcast, closeForRevokedKey, type SocketLike } from './socket-broadcast'
import type { PomodoroSnapshot } from './pomodoro-timer'
import type { SpeechMute } from './speech-config'
import type { KanjiQuizCall, KanjiQuizNotice, StreamStopOrder } from './kanji-quiz-call'
import type { TaskDeskSnapshot } from './task-desk'
import type { TextsSnapshot } from './text'
import type { TownTourAnswerMessage, TownTourCall } from './town-tour-call'
import type { TwisterCall } from './twister-call'
import type { WorkLogEntry } from './work-log'

/** Durable Object の名前。配送先は1つだけなので、決め打ちの名前で同じものを指す */
const CHANNEL_NAME = 'alerts'

/** Worker がアラートの押し出しに使うパス。外には出ない（オーバーレイ用キーの確認はWorkerが済ませている） */
const PUSH_PATH = '/push'
/** Worker がBGMの切り替えの押し出しに使うパス */
const PUSH_BGM_PATH = '/push/bgm'
/** Worker が作業ログの1行の押し出しに使うパス */
const PUSH_WORK_LOG_PATH = '/push/work-log'
/** Worker が作業机の押し出しに使うパス */
const PUSH_TASK_DESK_PATH = '/push/task-desk'
/** Worker がポモドーロのタイマーの押し出しに使うパス */
const PUSH_POMODORO_PATH = '/push/pomodoro'
/** Worker が市町村紹介の呼び出しの押し出しに使うパス */
const PUSH_TOWN_TOUR_PATH = '/push/town-tour'
/** Worker が配信のBGMを下げる知らせの押し出しに使うパス */
const PUSH_BGM_DUCK_PATH = '/push/bgm-duck'
/** Worker が読み上げのミュートの押し出しに使うパス */
const PUSH_SPEECH_MUTE_PATH = '/push/speech-mute'
/** Worker がツイスターの呼び出しの押し出しに使うパス */
const PUSH_TWISTER_PATH = '/push/twister'
/** Worker がテキストの一覧の押し出しに使うパス */
const PUSH_TEXT_PATH = '/push/text'
/** Worker が漢字クイズの出題の押し出しに使うパス */
const PUSH_KANJI_QUIZ_PATH = '/push/kanji-quiz'
/** Worker が配信を止める命令の押し出しに使うパス */
const PUSH_STREAM_STOP_PATH = '/push/stream-stop'
/** Worker がオーバーレイ用キーを発行し直したときに、開いている接続を閉じさせるパス */
const REVOKE_PATH = '/revoke'

/** アラートを受け取る接続（合成ページ）に付ける目印 */
const ALERTS_TOPIC = 'alerts'
/** BGMの切り替えを受け取る接続（裏方のページ）に付ける目印 */
const BGM_TOPIC = 'bgm'
/** 作業ログの1行を受け取る接続（合成ページの素材「作業ログ」）に付ける目印 */
const WORK_LOG_TOPIC = 'workLog'
/** 作業机を受け取る接続（合成ページの素材「作業机」）に付ける目印 */
const TASK_DESK_TOPIC = 'taskDesk'
/** ポモドーロのタイマーを受け取る接続（合成ページの素材「ポモドーロ」）に付ける目印 */
const POMODORO_TOPIC = 'pomodoro'
/** 市町村紹介の呼び出しを受け取る接続（合成ページの素材「市町村紹介」）に付ける目印 */
const TOWN_TOUR_TOPIC = 'townTour'
/** 配信のBGMを下げる知らせを受け取る接続（裏方のページ）に付ける目印 */
const BGM_DUCK_TOPIC = 'bgmDuck'
/** 読み上げのミュートを受け取る接続（読み上げのページ）に付ける目印 */
const SPEECH_MUTE_TOPIC = 'speechMute'
/** ツイスターの呼び出しを受け取る接続（合成ページの素材「ツイスター」）に付ける目印 */
const TWISTER_TOPIC = 'twister'
/** テキストの一覧を受け取る接続（合成ページの素材「テキスト」）に付ける目印 */
const TEXT_TOPIC = 'text'
/** 漢字クイズの出題を受け取る接続（合成ページの素材「漢字クイズ」）に付ける目印 */
const KANJI_QUIZ_TOPIC = 'kanjiQuiz'
/** 配信を止める命令を受け取る接続（裏方のページ）に付ける目印 */
const STREAM_STOP_TOPIC = 'streamStop'
/** 受け入れる接続の目印。知らない値はアラートの接続として受け入れる（Worker が必ずどれかを付けて渡す） */
const TOPICS: readonly string[] = [
  ALERTS_TOPIC,
  BGM_TOPIC,
  WORK_LOG_TOPIC,
  TASK_DESK_TOPIC,
  POMODORO_TOPIC,
  TOWN_TOUR_TOPIC,
  BGM_DUCK_TOPIC,
  SPEECH_MUTE_TOPIC,
  TWISTER_TOPIC,
  TEXT_TOPIC,
  KANJI_QUIZ_TOPIC,
  STREAM_STOP_TOPIC,
]
/** どちらの目印で受け入れるかを Worker が伝えるためのクエリ。外には出ない */
const TOPIC_PARAM = 'topic'

/** オーバーレイが送ってくる合図と、それに返す合図。Durable Object を起こさずに応えるために使う */
const PING = 'ping'
const PONG = 'pong'

/** アラートの送り先。実体は配送の共通部分（socket-broadcast.ts）の接続と同じ */
export type AlertSocket = SocketLike

/**
 * Durable Object から使う、接続の保持の仕組み。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の DurableObjectState はこの形を満たす。
 */
export interface AlertChannelState {
  acceptWebSocket(socket: WebSocket, tags?: string[]): void
  getWebSockets(tag?: string): AlertSocket[]
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void
  /** いまのオーバーレイ用キーの目印を覚えておく保管庫 */
  storage: DurableStorage
}

/** 目印の違うキーで開こうとした接続に返す応答。Worker の requireOverlayKey と同じ形にする */
const staleKeyResponse = (): Response =>
  errorResponse(STATUS.unauthorized, 'invalid-overlay-key', 'オーバーレイ用キーが正しくありません。管理画面のURLを貼り直してください')

/**
 * Worker が Durable Object を呼ぶための入口。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の DurableObjectNamespace はこの形を満たす。
 */
export interface AlertChannelNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> }
}

/**
 * アラートを配るだけの Durable Object。
 *
 * 呼ぶのは Worker だけで、次の2つを受け付ける。
 * - Upgrade: websocket のリクエスト: オーバーレイからの接続を受ける（パスはWorkerのものがそのまま届く）。
 *   クエリの topic が bgm ならBGMの接続、workLog なら作業ログの接続、taskDesk なら作業机の接続、pomodoro ならポモドーロの接続、
 *   townTour なら市町村紹介の接続、bgmDuck なら配信のBGMを下げる知らせの接続、speechMute なら読み上げのミュートの接続、
 *   twister ならツイスターの接続、text ならテキストの接続、kanjiQuiz なら漢字クイズの接続、streamStop なら配信を止める命令の接続、
 *   それ以外はアラートの接続として受け入れる
 * - POST /push: Worker が押し出したアラートを、アラートの接続すべてへ配る
 * - POST /push/bgm: Worker が押し出した「いま流している曲」を、BGMの接続すべてへ配る
 * - POST /push/work-log: Worker が押し出した作業ログの1行を、作業ログの接続すべてへ配る
 * - POST /push/task-desk: Worker が押し出したいまの作業机を、作業机の接続すべてへ配る
 * - POST /push/pomodoro: Worker が押し出したいまのポモドーロのタイマーを、ポモドーロの接続すべてへ配る
 * - POST /push/town-tour: Worker が押し出した市町村紹介の呼び出しを、市町村紹介の接続すべてへ配る
 * - POST /push/bgm-duck: Worker が押し出した配信のBGMを下げる知らせを、下げる知らせの接続すべてへ配る
 * - POST /push/speech-mute: Worker が押し出した読み上げのミュートを、ミュートの接続すべてへ配る
 * - POST /push/twister: Worker が押し出したツイスターの呼び出しを、ツイスターの接続すべてへ配る
 * - POST /push/text: Worker が押し出したテキストの一覧を、テキストの接続すべてへ配る
 * - POST /push/kanji-quiz: Worker が押し出した漢字クイズの出題を、漢字クイズの接続すべてへ配る
 * - POST /push/stream-stop: Worker が押し出した配信を止める命令を、停止の接続のうち送れた1つへ配る。1つも無ければ409を返す
 * - POST /revoke: 新しいキーの目印を覚え、接続をすべて閉じる（オーバーレイ用キーを発行し直したとき。どの接続もオーバーレイ用キーで開かれている）
 *
 * 接続はどれもオーバーレイ用キーで開かれるので、覚えている目印と違うキーの接続は受け入れない（worker/overlay-key.ts）。
 */
export class AlertChannel {
  /** Cloudflare は (state, env) の2つを渡すが、この Durable Object は保管も外部との通信も行わないので state だけを受け取る */
  constructor(private readonly ctx: AlertChannelState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.headers.get('Upgrade') === 'websocket') {
      if (!(await isCurrentKeyTag(this.ctx.storage, url.searchParams.get(KEY_TAG_PARAM)))) return staleKeyResponse()
      const topic = url.searchParams.get(TOPIC_PARAM)
      return this.accept(topic !== null && TOPICS.includes(topic) ? topic : ALERTS_TOPIC)
    }
    if (url.pathname === PUSH_PATH) return this.push(ALERTS_TOPIC, await request.text(), 'アラート')
    if (url.pathname === PUSH_BGM_PATH) return this.push(BGM_TOPIC, await request.text(), 'BGMの切り替え')
    if (url.pathname === PUSH_WORK_LOG_PATH) return this.push(WORK_LOG_TOPIC, await request.text(), '作業ログ')
    if (url.pathname === PUSH_TASK_DESK_PATH) return this.push(TASK_DESK_TOPIC, await request.text(), '作業机')
    if (url.pathname === PUSH_POMODORO_PATH) return this.push(POMODORO_TOPIC, await request.text(), 'ポモドーロのタイマー')
    if (url.pathname === PUSH_TOWN_TOUR_PATH) return this.push(TOWN_TOUR_TOPIC, await request.text(), '市町村紹介')
    if (url.pathname === PUSH_BGM_DUCK_PATH) return this.push(BGM_DUCK_TOPIC, await request.text(), '配信のBGMを下げる知らせ')
    if (url.pathname === PUSH_SPEECH_MUTE_PATH) return this.push(SPEECH_MUTE_TOPIC, await request.text(), '読み上げのミュート')
    if (url.pathname === PUSH_TWISTER_PATH) return this.push(TWISTER_TOPIC, await request.text(), 'ツイスター')
    if (url.pathname === PUSH_TEXT_PATH) return this.push(TEXT_TOPIC, await request.text(), 'テキスト')
    if (url.pathname === PUSH_KANJI_QUIZ_PATH) return this.push(KANJI_QUIZ_TOPIC, await request.text(), '漢字クイズ')
    if (url.pathname === PUSH_STREAM_STOP_PATH) {
      const payload = await request.text()
      // 裏方を2つ開いていても StopStream を2回送らないよう、送れた1つで止める（送れなかった接続は broadcast が閉じる）
      const delivered = this.ctx.getWebSockets(STREAM_STOP_TOPIC).some((socket) => broadcast([socket], payload, '配信を止める命令') > 0)
      // 受け取る裏方が1つも無ければ、止まらなかったことを Worker に記録させる
      return new Response(null, { status: delivered ? STATUS.noContent : STATUS.conflict })
    }
    if (url.pathname === REVOKE_PATH) {
      // 先に目印を覚えてから閉じる。閉じたあとすぐ古いキーでつなぎ直されても受け入れないため
      if (!(await rememberKeyTag(this.ctx.storage, request))) return new Response(null, { status: STATUS.badRequest })
      closeForRevokedKey(this.ctx.getWebSockets())
      return new Response(null, { status: STATUS.noContent })
    }
    return new Response(null, { status: STATUS.notFound })
  }

  /** オーバーレイからの接続を受け取り、片方を返す。Hibernation API で受けるので、待っている間は課金されない */
  private accept(topic: string): Response {
    // つないでいる間の合図（ping）には、この Durable Object を起こさずに応える（起こすと待っている間も課金される）
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server, [topic])
    return new Response(null, { status: 101, webSocket: client })
  }

  /** 押し出されたものを、その目印の接続すべてへ配る */
  private push(topic: string, payload: string, subject: string): Response {
    broadcast(this.ctx.getWebSockets(topic), payload, subject)
    return new Response(null, { status: STATUS.noContent })
  }
}

/** 配送先（1つだけ）を指す */
const channelOf = (namespace: AlertChannelNamespace): { fetch(request: Request): Promise<Response> } =>
  namespace.get(namespace.idFromName(CHANNEL_NAME))

/**
 * オーバーレイからのWebSocketの接続を Durable Object へ引き渡す。
 *
 * オーバーレイ用キーの確認は呼び出し側（overlay-routes.ts）が済ませている。
 *
 * @param keyTag 確かめたキーの目印（overlayKeyTag）
 */
export const connectAlertSocket = (namespace: AlertChannelNamespace, request: Request, keyTag: string): Promise<Response> =>
  connectWithTopic(namespace, request, ALERTS_TOPIC, keyTag)

/**
 * 裏方のページからのWebSocketの接続を、BGMの切り替えを受け取る接続として Durable Object へ引き渡す。
 *
 * オーバーレイ用キーの確認は呼び出し側（bgm-routes.ts）が済ませている。
 *
 * @param keyTag 確かめたキーの目印（overlayKeyTag）
 */
export const connectBgmSocket = (namespace: AlertChannelNamespace, request: Request, keyTag: string): Promise<Response> =>
  connectWithTopic(namespace, request, BGM_TOPIC, keyTag)

/**
 * 合成ページの素材「作業ログ」からのWebSocketの接続を、作業ログの1行を受け取る接続として Durable Object へ引き渡す。
 *
 * オーバーレイ用キーの確認は呼び出し側（work-log-routes.ts）が済ませている。
 *
 * @param keyTag 確かめたキーの目印（overlayKeyTag）
 */
export const connectWorkLogSocket = (namespace: AlertChannelNamespace, request: Request, keyTag: string): Promise<Response> =>
  connectWithTopic(namespace, request, WORK_LOG_TOPIC, keyTag)

/**
 * 合成ページの素材「作業机」からのWebSocketの接続を、作業机を受け取る接続として Durable Object へ引き渡す。
 *
 * オーバーレイ用キーの確認は呼び出し側（task-desk-routes.ts）が済ませている。
 *
 * @param keyTag 確かめたキーの目印（overlayKeyTag）
 */
export const connectTaskDeskSocket = (namespace: AlertChannelNamespace, request: Request, keyTag: string): Promise<Response> =>
  connectWithTopic(namespace, request, TASK_DESK_TOPIC, keyTag)

/**
 * 合成ページの素材「ポモドーロ」からのWebSocketの接続を、タイマーを受け取る接続として Durable Object へ引き渡す。
 *
 * オーバーレイ用キーの確認は呼び出し側（pomodoro-routes.ts）が済ませている。
 *
 * @param keyTag 確かめたキーの目印（overlayKeyTag）
 */
export const connectPomodoroSocket = (namespace: AlertChannelNamespace, request: Request, keyTag: string): Promise<Response> =>
  connectWithTopic(namespace, request, POMODORO_TOPIC, keyTag)

/**
 * 合成ページの素材「テキスト」からのWebSocketの接続を、テキストの一覧を受け取る接続として Durable Object へ引き渡す。
 *
 * オーバーレイ用キーの確認は呼び出し側（text-routes.ts）が済ませている。
 *
 * @param keyTag 確かめたキーの目印（overlayKeyTag）
 */
export const connectTextSocket = (namespace: AlertChannelNamespace, request: Request, keyTag: string): Promise<Response> =>
  connectWithTopic(namespace, request, TEXT_TOPIC, keyTag)

/**
 * 合成ページの素材「漢字クイズ」からのWebSocketの接続を、漢字クイズの出題を受け取る接続として Durable Object へ引き渡す。
 *
 * オーバーレイ用キーの確認は呼び出し側（kanji-quiz-routes.ts）が済ませている。
 *
 * @param keyTag 確かめたキーの目印（overlayKeyTag）
 */
export const connectKanjiQuizSocket = (namespace: AlertChannelNamespace, request: Request, keyTag: string): Promise<Response> =>
  connectWithTopic(namespace, request, KANJI_QUIZ_TOPIC, keyTag)

/**
 * 裏方のページの「配信の停止」からのWebSocketの接続を、配信を止める命令を受け取る接続として Durable Object へ引き渡す（issue #302）。
 *
 * オーバーレイ用キーの確認は呼び出し側（kanji-quiz-routes.ts）が済ませている。
 *
 * @param keyTag 確かめたキーの目印（overlayKeyTag）
 */
export const connectStreamStopSocket = (namespace: AlertChannelNamespace, request: Request, keyTag: string): Promise<Response> =>
  connectWithTopic(namespace, request, STREAM_STOP_TOPIC, keyTag)

/**
 * 合成ページの素材「市町村紹介」からのWebSocketの接続を、市町村紹介の呼び出しを受け取る接続として Durable Object へ引き渡す。
 *
 * オーバーレイ用キーの確認は呼び出し側（town-tour-routes.ts）が済ませている。
 *
 * @param keyTag 確かめたキーの目印（overlayKeyTag）
 */
export const connectTownTourSocket = (namespace: AlertChannelNamespace, request: Request, keyTag: string): Promise<Response> =>
  connectWithTopic(namespace, request, TOWN_TOUR_TOPIC, keyTag)

/**
 * 合成ページの素材「ツイスター」からのWebSocketの接続を、ツイスターの呼び出しを受け取る接続として Durable Object へ引き渡す。
 *
 * オーバーレイ用キーの確認は呼び出し側（twister-routes.ts）が済ませている。
 *
 * @param keyTag 確かめたキーの目印（overlayKeyTag）
 */
export const connectTwisterSocket = (namespace: AlertChannelNamespace, request: Request, keyTag: string): Promise<Response> =>
  connectWithTopic(namespace, request, TWISTER_TOPIC, keyTag)

/**
 * 裏方のページからのWebSocketの接続を、配信のBGMを下げる知らせを受け取る接続として Durable Object へ引き渡す。
 *
 * オーバーレイ用キーの確認は呼び出し側（bgm-routes.ts）が済ませている。
 *
 * @param keyTag 確かめたキーの目印（overlayKeyTag）
 */
export const connectBgmDuckSocket = (namespace: AlertChannelNamespace, request: Request, keyTag: string): Promise<Response> =>
  connectWithTopic(namespace, request, BGM_DUCK_TOPIC, keyTag)

/**
 * 読み上げのページからのWebSocketの接続を、読み上げのミュートを受け取る接続として Durable Object へ引き渡す。
 *
 * オーバーレイ用キーの確認は呼び出し側（speech-routes.ts）が済ませている。
 *
 * @param keyTag 確かめたキーの目印（overlayKeyTag）
 */
export const connectSpeechMuteSocket = (namespace: AlertChannelNamespace, request: Request, keyTag: string): Promise<Response> =>
  connectWithTopic(namespace, request, SPEECH_MUTE_TOPIC, keyTag)

/** 受け取る側の目印とキーの目印をクエリに載せて接続を引き渡す。利用者の送ってきた値は上書きする */
const connectWithTopic = (namespace: AlertChannelNamespace, request: Request, topic: string, keyTag: string): Promise<Response> => {
  const url = new URL(request.url)
  url.searchParams.set(TOPIC_PARAM, topic)
  url.searchParams.set(KEY_TAG_PARAM, keyTag)
  return channelOf(namespace).fetch(new Request(url, request))
}

/** Durable Object へ JSON を押し出す。失敗を返されたら投げる */
const pushJson = async (namespace: AlertChannelNamespace, path: string, body: unknown, subject: string): Promise<void> => {
  const response = await channelOf(namespace).fetch(
    new Request(`https://alert-channel${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  )
  if (!response.ok) throw new Error(`${subject}を配送先へ送れませんでした（${response.status}）`)
}

/**
 * 当てはまったアラートを Durable Object へ押し出す。
 *
 * 注意: 失敗を黙って握りつぶさない。呼び出し側（webhook-routes.ts）が収集の失敗として記録し、
 * 管理画面から気づけるようにする。
 */
export const pushAlert = (namespace: AlertChannelNamespace, alert: OverlayAlert): Promise<void> => pushJson(namespace, PUSH_PATH, alert, 'アラート')

/**
 * 「いま流している曲」を Durable Object へ押し出す。管理画面で流す曲や音量を変えたときに呼ぶ。
 *
 * 注意: 失敗を黙って握りつぶさない。呼び出し側（bgm-routes.ts）が管理画面へ失敗を返す。
 */
export const pushBgm = (namespace: AlertChannelNamespace, nowPlaying: BgmNowPlaying): Promise<void> =>
  pushJson(namespace, PUSH_BGM_PATH, nowPlaying, 'BGMの切り替え')

/**
 * 作業ログの1行を Durable Object へ押し出す。開発の出来事が届いたときと、配信中に章ができたときに呼ぶ。
 *
 * 注意: 失敗を黙って握りつぶさない。呼び出し側（github-routes.ts・collect.ts）が失敗として返すか記録する。
 */
export const pushWorkLogEntry = (namespace: AlertChannelNamespace, entry: WorkLogEntry): Promise<void> =>
  pushJson(namespace, PUSH_WORK_LOG_PATH, entry, '作業ログ')

/**
 * いまの作業机を Durable Object へ押し出す。視聴者の宣言・完了と、モデレーションで宣言を消したときに呼ぶ。
 *
 * 注意: 失敗を黙って握りつぶさない。呼び出し側（task-desk-command.ts）が失敗として記録する。
 */
export const pushTaskDesk = (namespace: AlertChannelNamespace, snapshot: TaskDeskSnapshot): Promise<void> =>
  pushJson(namespace, PUSH_TASK_DESK_PATH, snapshot, '作業机')

/**
 * いまのポモドーロのタイマーを Durable Object へ押し出す。始めた・一時停止した・再開した・止めたときに呼ぶ
 * （区切りでは押し出さない。合成ページは始めた時刻と現在時刻から区切りを自分で計算するため）。
 *
 * 注意: 失敗を黙って握りつぶさない。呼び出し側（pomodoro-timer.ts）が失敗として記録する。
 */
export const pushPomodoro = (namespace: AlertChannelNamespace, snapshot: PomodoroSnapshot): Promise<void> =>
  pushJson(namespace, PUSH_POMODORO_PATH, snapshot, 'ポモドーロのタイマー')

/**
 * いまのテキストの一覧を Durable Object へ押し出す。管理画面と下部バーでテキストを追加・書き換え・削除したときに呼ぶ。
 *
 * 注意: 失敗を黙って握りつぶさない。呼び出し側（text-routes.ts）が管理画面へ失敗を返す。
 */
export const pushTexts = (namespace: AlertChannelNamespace, snapshot: TextsSnapshot): Promise<void> => pushJson(namespace, PUSH_TEXT_PATH, snapshot, 'テキスト')

/**
 * 漢字クイズの出題を Durable Object へ押し出す。チャンネルポイントのトリガーと管理画面の試し再生で呼ぶ。
 *
 * 合成ページを開いていなければ配る先が無いだけで、失敗ではない（配送先は204を返す。つながっていない間の出題は貯めずに落とす）。
 *
 * 注意: 失敗を黙って握りつぶさない。呼び出し側が失敗として記録する（試し再生は502にする）。
 */
export const pushKanjiQuiz = (namespace: AlertChannelNamespace, call: KanjiQuizCall): Promise<void> => pushJson(namespace, PUSH_KANJI_QUIZ_PATH, call, '漢字クイズ')

/**
 * 漢字クイズの知らせ（最初の正解者・出題できなかった理由。issue #301）を Durable Object へ押し出す。
 *
 * 受け取るのは出題と同じ素材「漢字クイズ」なので、同じ経路で送り、type で出題と見分けさせる（市町村紹介の正解者と同じ考え方）。
 *
 * 注意: 失敗を黙って握りつぶさない。呼び出し側（webhook-routes.ts・kanji-quiz-issue.ts）が失敗として記録するか投げる。
 */
export const pushKanjiQuizNotice = (namespace: AlertChannelNamespace, notice: KanjiQuizNotice): Promise<void> =>
  pushJson(namespace, PUSH_KANJI_QUIZ_PATH, notice, KANJI_QUIZ_NOTICE_SUBJECTS[notice.type])

/** 漢字クイズの知らせの種類ごとの、失敗の文面に使う呼び名 */
const KANJI_QUIZ_NOTICE_SUBJECTS: Record<KanjiQuizNotice['type'], string> = {
  answer: '漢字クイズの正解者',
  failure: '漢字クイズの失敗',
  stopping: '配信の停止の猶予',
  stopCancelled: '配信の停止の取り消し',
}

/**
 * 配信を止める命令を Durable Object へ押し出す（issue #302）。漢字クイズの猶予が尽きたときに、鍵を確保してから呼ぶ。
 *
 * 注意: 受け取る裏方のページが1つもつながっていなければ（409）、そのことが分かる理由で投げる。
 *   呼び出し側（kanji-quiz-stop.ts）が失敗として記録する。
 */
export const pushStreamStop = async (namespace: AlertChannelNamespace, order: StreamStopOrder): Promise<void> => {
  const response = await channelOf(namespace).fetch(
    new Request(`https://alert-channel${PUSH_STREAM_STOP_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(order) }),
  )
  if (response.status === STATUS.conflict) {
    throw new Error('配信を止める命令を受け取る裏方のページ（配信の停止）がつながっていないため、配信を止められませんでした')
  }
  if (!response.ok) throw new Error(`配信を止める命令を配送先へ送れませんでした（${response.status}）`)
}

/**
 * 市町村紹介の呼び出し（引いた市町村と冒頭の一文）を Durable Object へ押し出す。トリガーと管理画面の試し再生で呼ぶ。
 *
 * 注意: 失敗を黙って握りつぶさない。呼び出し側（alert-actions.ts・town-tour-routes.ts）が失敗として記録するか返す。
 */
export const pushTownTour = (namespace: AlertChannelNamespace, call: TownTourCall): Promise<void> =>
  pushJson(namespace, PUSH_TOWN_TOUR_PATH, call, '市町村紹介')

/**
 * 都道府県当てクイズ（issue #251）の最初の正解者を Durable Object へ押し出す。Webhook がチャットの正解を受けたときに呼ぶ。
 *
 * 受け取るのは呼び出しと同じ素材「市町村紹介」なので、同じ経路で送り、type: answer で呼び出しと見分けさせる。
 *
 * 注意: 失敗を黙って握りつぶさない。呼び出し側（webhook-routes.ts）が失敗として投げる。
 */
export const pushTownTourAnswer = (namespace: AlertChannelNamespace, answer: Omit<TownTourAnswerMessage, 'type'>): Promise<void> =>
  pushJson(namespace, PUSH_TOWN_TOUR_PATH, { type: 'answer', ...answer } satisfies TownTourAnswerMessage, 'クイズの正解者')

/**
 * ツイスターの呼び出し（対戦の種と2人）を Durable Object へ押し出す。レイドのトリガーと管理画面の試し再生で呼ぶ。
 *
 * 合成ページを開いていなければ配る先が無いだけで、失敗ではない（配送先は204を返す。つながっていない間の呼び出しは貯めずに落とす）。
 *
 * 注意: 失敗を黙って握りつぶさない。呼び出し側が失敗として記録する（試し再生は502にする）。
 */
export const pushTwister = (namespace: AlertChannelNamespace, call: TwisterCall): Promise<void> => pushJson(namespace, PUSH_TWISTER_PATH, call, 'ツイスター')

/**
 * 配信のBGMを下げる知らせを Durable Object へ押し出す。合成ページが市町村紹介のBGMを鳴らすあいだに呼ぶ。
 *
 * 裏方のページが開いていなければ配る先が無いだけで、失敗ではない（配送先は204を返す）。
 *
 * 注意: 失敗を黙って握りつぶさない。呼び出し側（bgm-routes.ts）が合成ページへ失敗を返す。
 */
export const pushBgmDuck = (namespace: AlertChannelNamespace, duck: BgmDuck): Promise<void> =>
  pushJson(namespace, PUSH_BGM_DUCK_PATH, duck, '配信のBGMを下げる知らせ')

/**
 * 読み上げのミュートを Durable Object へ押し出す。下部バーでミュートを切り替えたときに呼ぶ。
 *
 * 読み上げのページが開いていなければ配る先が無いだけで、失敗ではない（配送先は204を返す）。
 *
 * 注意: 失敗を黙って握りつぶさない。呼び出し側（speech-routes.ts）が管理画面へ失敗を返す。
 */
export const pushSpeechMute = (namespace: AlertChannelNamespace, mute: SpeechMute): Promise<void> =>
  pushJson(namespace, PUSH_SPEECH_MUTE_PATH, mute, '読み上げのミュート')

/**
 * オーバーレイ用キーを発行し直したときに、新しいキーの目印を覚えさせ、開いている接続（アラート・BGM・作業ログ・作業机・ポモドーロ・市町村紹介・配信のBGMを下げる知らせ・読み上げのミュート・ツイスター・テキスト・漢字クイズ・配信の停止）をすべて閉じさせる。
 *
 * 注意: 失敗を黙って握りつぶさない。閉じられないと古いキーの接続が残るので、呼び出し側（admin-routes.ts）が失敗を返す。
 *
 * @param keyTag 新しいキーの目印（overlayKeyTag）
 */
export const revokeAlertSockets = async (namespace: AlertChannelNamespace, keyTag: string): Promise<void> => {
  const response = await channelOf(namespace).fetch(revokeRequest(`https://alert-channel${REVOKE_PATH}`, keyTag))
  if (!response.ok) throw new Error(`アラート・BGM・作業ログ・作業机・ポモドーロ・市町村紹介・配信のBGMを下げる知らせの接続を切断できませんでした（${response.status}）`)
}
