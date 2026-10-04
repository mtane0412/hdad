/**
 * アプリの枠で持つ、BGMの再生の状態（issue #236）
 *
 * BGMは下部バー（bgm-bar.tsx）と BGM のページ（bgm-page.tsx）の2か所で操作する。どちらも同じ状態を映すように、
 * 再生の状態（保存済みの曲の一覧・いま流す曲と音量・自動の切り替えの設定）と押し出しの接続をこの Provider だけが持ち、
 * アプリの枠（app.tsx の Shell）に置く。ページを移っても枠は作り直されないので、接続は1本のまま続く。
 *
 * - 開いたときに Worker から読み、曲の終わりで進んだ・Jev が切り替えたことは裏方と同じ押し出し（socket.ts）で受け取る
 * - つなぎ直したら読み直す（つながっていない間に切り替わっていたかもしれないため）
 * - 操作（流す曲・音量・次の曲・前の曲）は Worker へ送り、返ってきた設定を映す。呼び出し側は返した Promise で
 *   成否を知り、それぞれの場所に結果を出す
 *
 * 注意: 操作の応答（HTTP）は Worker が押し出したあとに返るので、曲の終わりや Jev によるもっと新しい押し出しより
 *   遅れて届くことがある。押し出しが届くたび・再生の設定を取りに行くたびに世代を進め、取りに行ったときから
 *   世代が進んでいたら、その応答は古いので映さない。
 * 注意: 読めなかったとき・押し出しを受け取れていないときは、黙らずに理由を持つ（Fail-Fast。表示は使う側）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage } from '@/admin/page-actions'
import { parseBgmNowPlaying, type BgmApi, type BgmPlayback, type BgmSettings, type BgmStep, type BgmTrack } from './api'

/** 押し出しの接続から受け取るもの（src/core/socket.ts の SocketHandlers と同じ形） */
export interface BgmWatchHandlers {
  /** 生存確認の返事でない文字列が届いた */
  onMessage(text: string): void
  /** 切断した（disconnected）・切断後に再びつながった（reconnected） */
  onStatus(status: 'disconnected' | 'reconnected'): void
  /** 待てば直るかもしれない失敗（つなぎ直しは続ける） */
  onWarning(message: string): void
}

/** 「いま流している曲」の押し出しにつなぐ（本番は socket.ts の connectBgmWatch） */
export type BgmConnect = (overlayKey: string, handlers: BgmWatchHandlers) => { close(): void }

export type BgmLoaded = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; message: string }

export interface BgmPlayerValue {
  loaded: BgmLoaded
  /** Worker に保存されている曲。流している曲の名前はここから引く */
  savedTracks: readonly BgmTrack[]
  playback: BgmPlayback
  settings: BgmSettings
  /** 押し出しを受け取れていない理由（オーバーレイ用キーが無いときを含む）。受け取れていれば null */
  watchNotice: string | null
  /** 流す曲・音量・リピート・シャッフルを Worker へ送る。Worker が裏方のページへ押し出す */
  savePlayback(next: BgmPlayback): Promise<BgmPlayback>
  /** 次の曲・前の曲へ進めてもらう。どの曲にするか（一覧の順・シャッフル）は Worker が決める */
  skip(step: BgmStep): Promise<BgmPlayback>
  saveSettings(next: BgmSettings): Promise<BgmSettings>
  /** 曲の一覧を保存し、保存済みの一覧を置き換える */
  saveTracks(tracks: readonly BgmTrack[]): Promise<readonly BgmTrack[]>
}

/** キーが無くて押し出しにつなげないときの知らせ */
const NO_OVERLAY_KEY_NOTICE = 'オーバーレイ用キーが未発行のため、曲の終わりや Jev による切り替えを映せません'

/** 押し出しが切れているときの知らせ */
const DISCONNECTED_NOTICE = 'BGMの切り替えを受け取れていません。つなぎ直しています'

const BgmPlayerContext = createContext<BgmPlayerValue | null>(null)

export const BgmPlayerProvider = ({
  api,
  overlayKey,
  connect,
  children,
}: {
  api: BgmApi
  /** ログイン中の配信者のオーバーレイ用キー。押し出しの経路はこのキーで守られている。未発行なら null */
  overlayKey: string | null
  connect: BgmConnect
  children: React.ReactNode
}) => {
  const [loaded, setLoaded] = useState<BgmLoaded>({ status: 'loading' })
  const [savedTracks, setSavedTracks] = useState<readonly BgmTrack[]>([])
  const [playback, setPlayback] = useState<BgmPlayback>({ mediaId: null, volume: 0, repeat: false, shuffle: false })
  const [settings, setSettings] = useState<BgmSettings>({ judgeWithJev: false })
  const [watchProblem, setWatchProblem] = useState<string | null>(null)

  /** 再生の設定の世代（冒頭の注意を参照） */
  const playbackRevision = useRef(0)

  /** 再生の設定を取りに行く直前に呼ぶ。返した関数は、応答を映してよい（あいだに新しいものが届いていない）かを答える */
  const beginPlaybackRequest = useCallback((): (() => boolean) => {
    playbackRevision.current += 1
    const revision = playbackRevision.current
    return () => revision === playbackRevision.current
  }, [])

  useEffect(() => {
    let cancelled = false
    const isLatest = beginPlaybackRequest()
    api.load().then(
      (bgm) => {
        if (cancelled) return
        setSavedTracks(bgm.tracks)
        if (isLatest()) setPlayback(bgm.playback)
        setSettings(bgm.settings)
        setLoaded({ status: 'ready' })
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, beginPlaybackRequest])

  // 曲の終わりで次の曲へ進んだ・Jev が切り替えたことを、裏方のページと同じ押し出しで受け取る
  useEffect(() => {
    // キーが無ければつなげない（知らせは watchNotice が受け持つ）
    if (overlayKey === null) return
    const connection = connect(overlayKey, {
      onMessage: (text) => {
        try {
          const nowPlaying = parseBgmNowPlaying(text)
          const { volume, repeat, shuffle } = nowPlaying
          beginPlaybackRequest()
          setPlayback({ mediaId: nowPlaying.track?.mediaId ?? null, volume, repeat, shuffle })
          setWatchProblem(null)
        } catch (error) {
          setWatchProblem(errorMessage(error))
        }
      },
      onStatus: (status) => {
        if (status === 'disconnected') {
          setWatchProblem(DISCONNECTED_NOTICE)
          return
        }
        // つながっていない間に切り替わっていたかもしれないので読み直す。別の画面で曲の一覧が保存されていても
        // 流している曲を引けるよう、保存済みの一覧も読み直す
        const isLatest = beginPlaybackRequest()
        api.load().then(
          (bgm) => {
            setSavedTracks(bgm.tracks)
            if (isLatest()) setPlayback(bgm.playback)
            setWatchProblem(null)
          },
          (error: unknown) => setWatchProblem(errorMessage(error)),
        )
      },
      onWarning: (message) => setWatchProblem(message),
    })
    return () => connection.close()
  }, [api, connect, overlayKey, beginPlaybackRequest])

  const value = useMemo<BgmPlayerValue>(() => {
    /** 再生の設定を取りに行き、あいだに新しいものが届いていなければ映す */
    const requestPlayback = async (request: () => Promise<BgmPlayback>): Promise<BgmPlayback> => {
      const isLatest = beginPlaybackRequest()
      const next = await request()
      if (isLatest()) setPlayback(next)
      return next
    }
    return {
      loaded,
      savedTracks,
      playback,
      settings,
      watchNotice: overlayKey === null ? NO_OVERLAY_KEY_NOTICE : watchProblem,
      savePlayback: (next) => requestPlayback(() => api.savePlayback(next)),
      skip: (step) => requestPlayback(() => api.skip(step)),
      saveSettings: async (next) => {
        const saved = await api.saveSettings(next)
        setSettings(saved)
        return saved
      },
      saveTracks: async (tracks) => {
        const saved = await api.saveTracks(tracks)
        setSavedTracks(saved)
        return saved
      },
    }
  }, [api, beginPlaybackRequest, loaded, overlayKey, playback, savedTracks, settings, watchProblem])

  return <BgmPlayerContext.Provider value={value}>{children}</BgmPlayerContext.Provider>
}

/** BGMの再生の状態を読む。BgmPlayerProvider の内側で使う */
export const useBgmPlayer = (): BgmPlayerValue => {
  const value = useContext(BgmPlayerContext)
  if (value === null) throw new Error('useBgmPlayer は BgmPlayerProvider の内側で使ってください')
  return value
}
