/**
 * Jev による BGM の切り替え
 *
 * 配信の話題や雰囲気に合う BGM へ、Jev（worker/jev.ts）が自動で切り替える（issue #153）。配信の記録の収集
 * （worker/collect.ts。5分おきの cron）であらすじを作り直せた回に、あらすじと直近の発話を材料にして、曲ごとの
 * 「曲調」「流したい場面」を選択肢の説明にした Choice の質問で1曲を選ばせる。いま流している曲も選択肢に入れ、
 * それが選ばれたら切り替えない（「いまの曲のまま」の選択肢を別に持たない）。
 *
 * 注意: 誤った切り替えは配信の雰囲気を壊すので、見送るほうを選ぶ。確信度がしきい値（BGM_CONFIDENCE_THRESHOLD）に
 * 届かなければ切り替えない。確信度が返ってこなければ、比べられないことを黙らずに投げる。
 * 注意: 曲を切り替えてから一定時間（BGM_SWITCH_COOLDOWN_MS）は、Jev を呼ばない。手で切り替えたときも同じ時刻を
 * 記録する（worker/bgm-routes.ts）ので、配信者が選んだ直後に Jev が上書きしない。
 * 注意: BGM を止めているあいだは呼ばない。配信者が止めたものを勝手に流し始めないためである。
 * 注意: 判定は数百ミリ秒かかるので、そのあいだに配信者が自動の切り替えを切った・手で切り替えた・止めた・曲を外したなら上書きしない
 * （KV なので確かめてから書くまでの間はふさげないが、判定を待つあいだの取り違えは防ぐ）。
 * 注意: Jev の失敗は投げる。呼び出し側が失敗として記録し、黙って曲を変えたり止めたりしない。
 */
import type { AlertChannelNamespace } from './alert-channel'
import {
  loadBgmPlayback,
  loadBgmSettings,
  loadBgmSwitchedAt,
  loadBgmTracks,
  saveBgmPlayback,
  saveBgmSwitchedAt,
  type BgmTrack,
} from './bgm-config'
import { pushBgmNowPlaying } from './bgm-push'
import type { ChoiceQuestion, JevClient, JevRequest } from './jev'
import type { KeyValueStore } from './store'

/**
 * 切り替えるとみなす確信度の下限。
 *
 * 誤った切り替えは配信の雰囲気を壊すので、迷っている答えでは切り替えない高さにとる。
 */
export const BGM_CONFIDENCE_THRESHOLD = 0.7

/** 曲を切り替えてから、Jev が次の切り替えを控える時間（ミリ秒）。曲が頻繁に変わるのを防ぐ */
export const BGM_SWITCH_COOLDOWN_MS = 10 * 60 * 1000

/** 材料にする直近の発話の数。あらすじだけでは拾えない「いまの空気」を補う */
export const BGM_TRANSCRIPT_CONTEXT = 10

/** 判定の材料 */
export interface BgmMaterial {
  /** これまでのあらすじ（worker/stream-summary.ts） */
  readonly summary: string
  /** 配信者の直近の発話（古い順） */
  readonly transcript: readonly string[]
}

/** 曲の並びの何番目かを、選択肢の名前にする */
const choiceName = (index: number): string => `t${index}`

/**
 * Jev に選ばせる候補の曲。
 *
 * 曲調も流したい場面も書いていない曲は、選ぶ手がかりが無いので外す。いま流している曲は、説明が無くても
 * 「いまの曲のまま」を選べるように残す。
 */
export const bgmCandidatesOf = (tracks: readonly BgmTrack[], playingMediaId: string): BgmTrack[] =>
  tracks.filter((track) => track.mediaId === playingMediaId || track.mood !== '' || track.scene !== '')

/** 曲1つを選択肢の説明にする */
const describeTrack = (track: BgmTrack, playing: boolean): string =>
  [
    `曲名「${track.title}」`,
    `曲調: ${track.mood === '' ? '（書かれていない）' : track.mood}`,
    `流したい場面: ${track.scene === '' ? '（書かれていない）' : track.scene}`,
    ...(playing ? ['（いま流している曲）'] : []),
  ].join('。')

/**
 * Jev へ渡す注文を組み立てる。
 *
 * @param candidates 候補の曲（bgmCandidatesOf）。並びの順に t0, t1… の選択肢になる
 * @param playingMediaId いま流している曲の素材のID
 */
export const buildBgmRequest = (
  material: BgmMaterial,
  candidates: readonly BgmTrack[],
  playingMediaId: string,
): JevRequest<{ track: ChoiceQuestion }> => ({
  state: { summary: material.summary, transcript: material.transcript },
  questions: {
    track: {
      type: 'choice',
      instructions:
        'ライブ配信で流すBGMを選びます。いまの配信の話題や雰囲気（`summary` はこれまでのあらすじ、`transcript` は配信者の直近の発話。古い順）に最も合う曲はどれですか。',
      criteria: Object.fromEntries(candidates.map((track, index) => [choiceName(index), describeTrack(track, track.mediaId === playingMediaId)])),
    },
  },
})

/** 判定に要るもの */
export interface BgmChoiceOptions extends BgmMaterial {
  /** BGMの曲・再生・設定を読み書きするストア（KV） */
  store: KeyValueStore
  jev: JevClient
  /** 切り替えを裏方のページへ押し出す配送先 */
  alerts: AlertChannelNamespace
  /** 現在時刻（ミリ秒） */
  now: number
}

/**
 * 配信の話題や雰囲気に合う曲を Jev に選ばせ、確信度がしきい値に届けば切り替える。
 *
 * @throws Error Jev が失敗した・確信度が返ってこなかった・保存や押し出しに失敗した場合（呼び出し側が失敗として記録する）
 */
export const chooseBgm = async ({ store, jev, alerts, now, summary, transcript }: BgmChoiceOptions): Promise<void> => {
  if (!(await loadBgmSettings(store)).judgeWithJev) return
  const playback = await loadBgmPlayback(store)
  if (playback.mediaId === null) return
  const switchedAt = await loadBgmSwitchedAt(store)
  if (switchedAt !== null && now - switchedAt < BGM_SWITCH_COOLDOWN_MS) return

  const candidates = bgmCandidatesOf(await loadBgmTracks(store), playback.mediaId)
  if (candidates.every((track) => track.mediaId === playback.mediaId)) return

  const { track: answer } = await jev.decide('bgm', buildBgmRequest({ summary, transcript }, candidates, playback.mediaId))
  if (answer.confidence === null) {
    throw new Error(`Jev が BGM の選択（${answer.choice}）の確信度を返さなかったので、しきい値と比べられません`)
  }
  // 選択肢の名前は jev.ts が選択肢にあるものだけ通すので、並びの中に必ずある
  const chosen = candidates.find((_, index) => choiceName(index) === answer.choice)
  if (chosen === undefined || chosen.mediaId === playback.mediaId || answer.confidence < BGM_CONFIDENCE_THRESHOLD) return

  // 判定のあいだに配信者が自動の切り替えを切った・手で切り替えた・止めた・選ばれた曲を外したなら、配信者の操作を優先する
  if (!(await loadBgmSettings(store)).judgeWithJev) return
  const latest = await loadBgmPlayback(store)
  const latestTracks = await loadBgmTracks(store)
  if (latest.mediaId !== playback.mediaId || (await loadBgmSwitchedAt(store)) !== switchedAt) return
  if (!latestTracks.some((track) => track.mediaId === chosen.mediaId)) return

  const next = { mediaId: chosen.mediaId, volume: latest.volume }
  await saveBgmPlayback(store, next)
  await saveBgmSwitchedAt(store, now)
  await pushBgmNowPlaying(store, alerts, latestTracks, next)
}
