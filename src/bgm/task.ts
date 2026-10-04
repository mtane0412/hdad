/**
 * BGMの起動（裏方のページの ?bgm=true）
 *
 * 管理画面（/bgm/）で選んだ曲を、OBSのブラウザソースの音声として鳴らす。流す曲と音量は Worker が持ち、
 * 開いたときに /api/overlay/bgm を読んで鳴らし始め、以後は切り替えを WebSocket（/api/overlay/bgm/socket）で
 * 押し出してもらう（issue #151）。ポーリングにしないのは、配信中の切り替えが数十秒遅れるためである。
 * つなぎ直したときは、つながっていない間の切り替えを取りこぼさないよう、もう一度読む。
 * リピートを切っているときは、曲が終わったら /api/overlay/bgm/ended で知らせ、Worker が決めた次の曲を流す。
 *
 * 市町村紹介のBGMが鳴るあいだは、合成ページから Worker 経由で「配信のBGMを下げておく長さ」が別の WebSocket
 * （/api/overlay/bgm/duck/socket）で届くので、受け取ってからその長さだけ下げ、過ぎたら自分で戻す（issue #245）。
 * 戻す時刻を受け取った側で数えるのは、合成ページが閉じられた・紹介が途中で失敗した・知らせが届かなかったときに、
 * 配信のBGMが下がったまま残らないようにするためである。
 *
 * 何をするかの判断は change.ts、音の再生は player.ts にあり、ここはそれらをつなぐだけである。
 * OBSに載せるページの約束どおり React もログインも持ち込まない。
 *
 * 注意: 起動のときの失敗（いま流している曲を読めない・再生を始められない）は投げて呼び出し側に画面へ出させる（Fail-Fast）。
 * 一方、配信中の切り替えの1回の失敗では止めず、失敗をこの裏方の箱に出したうえで次の切り替えを待つ
 * （1回の失敗のためにBGMの裏方ごと止まると、OBSの再読み込みが要るため。読み上げが1件の失敗を飛ばすのと同じ例外）。
 */
import { clearError, showError } from '../core/mount'
import { connectSocket, socketUrl } from '../core/socket'
import { BGM_DUCK_SOCKET_HINT, BGM_DUCK_SOCKET_PATH, BGM_SOCKET_HINT, BGM_SOCKET_PATH, createBgmOverlayApi, parseBgmDuck, parseBgmNowPlaying, type BgmNowPlaying } from './api'
import { bgmChangeOf } from './change'
import { createBgmPlayer } from './player'

/** エラー表示でこの裏方を指す呼び名 */
export const BGM_NOUN = 'BGM'

/** いま鳴らしているものを、箱に1行で出す文 */
const statusTextOf = (nowPlaying: BgmNowPlaying): string =>
  nowPlaying.track === null ? 'BGMを止めています' : `「${nowPlaying.track.title}」を流しています（${nowPlaying.track.credit}）`

export interface BgmTaskOptions {
  /** オーバーレイ用キー */
  readonly key: string
  /** 失敗と、いま鳴らしているものを出す箱 */
  readonly box: HTMLElement
}

/**
 * BGMを始める。
 *
 * @throws 起動に失敗した場合（いま流している曲を読めない・再生を始められない）
 */
export const startBgm = async ({ key, box }: BgmTaskOptions): Promise<void> => {
  const api = createBgmOverlayApi((input, init) => fetch(input, init), key)
  const player = createBgmPlayer(
    (error) => showError(error, BGM_NOUN, box, 'read'),
    () => onEnded(),
  )

  const status = document.createElement('p')
  status.className = 'backstage-status'
  status.setAttribute('role', 'status')

  /** いま鳴らしているもの。まだ何も受け取っていなければ null */
  let current: BgmNowPlaying | null = null
  /** 切り替えを1つずつ順に行うための列。フェードの途中で次の切り替えが届いても、前のものを終えてから行う */
  let queue: Promise<void> = Promise.resolve()

  /** 届いた曲に合わせる */
  const follow = async (next: BgmNowPlaying): Promise<void> => {
    await player.apply(bgmChangeOf(current, next))
    current = next
    status.textContent = statusTextOf(next)
  }

  /** 配信中の切り替え。失敗しても止めず、箱に出して次を待つ */
  const followLater = (next: () => Promise<BgmNowPlaying>): void => {
    queue = queue
      .then(async () => {
        await follow(await next())
        clearError(box, 'read')
      })
      .catch((error: unknown) => showError(error, BGM_NOUN, box, 'read'))
  }

  /**
   * 鳴らしていた曲が終わった。Worker に知らせて次の曲を受け取る。
   *
   * 知らせる前に「何も鳴らしていない」ことにしておく。曲が1つだけで次の曲も同じ曲のとき、同じ曲だからと
   * 鳴らし直さずに黙ってしまわないためである。応答より先に同じ切り替えが押し出されてきても、
   * 後から届いたほうは同じ曲なので何もしない。
   * 終わった曲は届いた時点で控える。列の順番を待つあいだに別の曲へ切り替わったら、その曲は流し続ける。
   *
   * 知らせに失敗したら、箱に出したうえで Worker のいまの曲を読み直して流す。「何も鳴らしていない」ことにしたまま
   * 押し出しを待つと、Worker の曲は変わらないので押し出しも来ず、つなぎ直すまで黙ってしまうためである。
   * 読み直した曲で鳴らせても、知らせの失敗は箱に残す（次の曲へ進めなかったことに気づけるように）。
   */
  const onEnded = (): void => {
    const endedMediaId = current?.track?.mediaId
    if (endedMediaId === undefined) return
    queue = queue
      .then(async () => {
        if (current?.track?.mediaId === endedMediaId) current = { ...current, track: null }
        try {
          await follow(await api.ended(endedMediaId))
          clearError(box, 'read')
        } catch (error) {
          showError(error, BGM_NOUN, box, 'read')
          await follow(await api.read())
        }
      })
      .catch((error: unknown) => showError(error, BGM_NOUN, box, 'read'))
  }

  // 1回目は起動の一部として扱う。ここで失敗したら画面に出して原因が分かるようにする
  await follow(await api.read())
  box.append(status)

  connectSocket(
    socketUrl(BGM_SOCKET_PATH, { key }),
    {
      onMessage: (text) => followLater(async () => parseBgmNowPlaying(text)),
      onStatus: (connection) => {
        // つながっていない間に切り替えられていたかもしれないので、つなぎ直したら読み直す
        if (connection === 'reconnected') followLater(() => api.read())
      },
      onWarning: (message) => showError(new Error(message), BGM_NOUN, box, 'read'),
    },
    BGM_SOCKET_HINT,
  )

  /** 下げたあと、元の音量へ戻すタイマー */
  let restoreTimer: number | undefined
  connectSocket(
    socketUrl(BGM_DUCK_SOCKET_PATH, { key }),
    {
      onMessage: (text) => {
        try {
          const { holdMs } = parseBgmDuck(text)
          // 新しい知らせが届いたら、前の知らせの戻す時刻は捨てて、新しい長さで数え直す
          window.clearTimeout(restoreTimer)
          player.duck(holdMs > 0)
          if (holdMs > 0) restoreTimer = window.setTimeout(() => player.duck(false), holdMs)
        } catch (error) {
          showError(error, BGM_NOUN, box, 'read')
        }
      },
      onStatus: () => {
        // つながっていない間の知らせは読み直さない（取りこぼしても、下げないほうへ倒れるだけで下がったまま残らない）
      },
      onWarning: (message) => showError(new Error(message), BGM_NOUN, box, 'read'),
    },
    BGM_DUCK_SOCKET_HINT,
  )
}
