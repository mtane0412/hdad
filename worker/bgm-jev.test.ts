/**
 * Jev による BGM の切り替え（bgm-jev.ts）のテスト
 *
 * あらすじを作り直したときに、あらすじと直近の発話を材料にして、配信の話題や雰囲気に合う曲を Jev に1曲選ばせる
 * （issue #153）。ここで確かめるのは次の点である。
 * - Jev へ渡す材料と質問の形（曲ごとの曲調・流したい場面を Choice の選択肢の説明にする）
 * - 確信度がしきい値に届いたときだけ切り替え、裏方のページへ押し出すこと
 * - 設定がオフ・止めている・切り替えの直後・ほかに候補が無いときは Jev を呼ばないこと
 * - 判定のあいだに配信者が手で切り替えていたら上書きしないこと
 * - Jev の失敗や確信度の欠けを、黙って捨てずに投げること（呼び出し側が失敗として記録する）
 */
import { describe, expect, it } from 'vitest'
import {
  loadBgmPlayback,
  loadBgmSwitchedAt,
  saveBgmPlayback,
  saveBgmSettings,
  saveBgmSwitchedAt,
  saveBgmTracks,
  type BgmTrack,
} from './bgm-config'
import { BGM_CONFIDENCE_THRESHOLD, BGM_SWITCH_COOLDOWN_MS, bgmCandidatesOf, buildBgmRequest, chooseBgm } from './bgm-jev'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeStore } from './fake-store'
import type { ChoiceAnswer, JevAnswers, JevClient, JevQuestion, JevRequest, JevUsage } from './jev'

const NOW = Date.parse('2026-09-29T12:00:00Z')
const ISSUED_KEY = 'issued-overlay-key-0123456789abcdefghij'

/** 雑談のときに流したい、落ち着いた曲 */
const casualTrack: BgmTrack = {
  mediaId: 'media-zatsudan',
  title: 'ひだまりの午後',
  credit: '音楽: 甘茶の音楽工房',
  creditUrl: 'https://amachamusic.chagasi.com/',
  mood: 'ゆったりしたアコースティック',
  scene: '雑談・作業配信',
}

/** ゲームで盛り上がったときに流したい曲 */
const hypeTrack: BgmTrack = {
  mediaId: 'media-moriagari',
  title: '全力疾走',
  credit: '音楽: DOVA-SYNDROME',
  creditUrl: 'https://dova-s.jp/',
  mood: 'テンポの速いロック',
  scene: 'ボス戦・盛り上がったとき',
}

/** 曲調も流したい場面も書いていない曲。Jev には選ばせようがない */
const undescribedTrack: BgmTrack = {
  mediaId: 'media-setsumei-nashi',
  title: '名前だけの曲',
  credit: '音楽: だれか',
  creditUrl: '',
  mood: '',
  scene: '',
}

const material = {
  summary: '雑談のあと、ホラーゲームを始めてボス戦に入った',
  transcript: ['うわ、ボス来た', 'これ勝てるかな', 'いくぞ！'],
}

/** Jev の代役。渡された注文を控え、決めた答えを返す（失敗させることもできる） */
const createFakeJev = (
  answer: ChoiceAnswer | Error,
): JevClient & { requests: JevRequest<Record<string, JevQuestion>>[]; usages: JevUsage[] } => {
  const requests: JevRequest<Record<string, JevQuestion>>[] = []
  const usages: JevUsage[] = []
  return {
    requests,
    usages,
    decide: async <Qs extends Readonly<Record<string, JevQuestion>>>(usage: JevUsage, request: JevRequest<Qs>): Promise<JevAnswers<Qs>> => {
      usages.push(usage)
      requests.push(request)
      if (answer instanceof Error) throw answer
      return { track: answer } as JevAnswers<Qs>
    },
  }
}

/** 雑談の曲を流していて、Jev に選ばせる設定を入れ、しばらく切り替えていない状態を用意する */
const setupPlayingCasualTrack = async (overrides: { tracks?: readonly BgmTrack[]; switchedAt?: number } = {}) => {
  const store = createFakeStore({ 'overlay-key': ISSUED_KEY })
  await saveBgmTracks(store, overrides.tracks ?? [casualTrack, hypeTrack])
  await saveBgmPlayback(store, { mediaId: casualTrack.mediaId, volume: 0.4 })
  await saveBgmSettings(store, { judgeWithJev: true })
  await saveBgmSwitchedAt(store, overrides.switchedAt ?? NOW - BGM_SWITCH_COOLDOWN_MS)
  const alertChannel = createFakeAlertChannel()
  return { store, alertChannel }
}

describe('bgmCandidatesOf', () => {
  it('曲調か流したい場面を書いてある曲と、いま流している曲を候補にする', () => {
    expect(bgmCandidatesOf([casualTrack, undescribedTrack, hypeTrack], casualTrack.mediaId)).toEqual([casualTrack, hypeTrack])
  })

  it('いま流している曲は、説明が無くても候補に入れる（「いまの曲のまま」を選べるようにするため）', () => {
    expect(bgmCandidatesOf([casualTrack, undescribedTrack], undescribedTrack.mediaId)).toEqual([casualTrack, undescribedTrack])
  })
})

describe('buildBgmRequest', () => {
  it('あらすじと直近の発話を材料にし、曲ごとの曲調・流したい場面を選択肢の説明にする', () => {
    const request = buildBgmRequest(material, [casualTrack, hypeTrack], casualTrack.mediaId)

    expect(request.state).toEqual({ summary: material.summary, transcript: material.transcript })
    expect(request.questions.track.type).toBe('choice')
    expect(Object.keys(request.questions.track.criteria)).toEqual(['t0', 't1'])
    // 選択肢の名前はモデルに意味が伝わりにくいので、曲名・曲調・流したい場面を説明に書く
    expect(request.questions.track.criteria.t1).toContain('全力疾走')
    expect(request.questions.track.criteria.t1).toContain('テンポの速いロック')
    expect(request.questions.track.criteria.t1).toContain('ボス戦・盛り上がったとき')
    // いま流している曲はそれと分かるようにする（選ばれたら切り替えない）
    expect(request.questions.track.criteria.t0).toContain('いま流している曲')
    expect(request.questions.track.criteria.t1).not.toContain('いま流している曲')
  })
})

describe('chooseBgm', () => {
  it('確信度がしきい値に届いたら、選ばれた曲へ切り替えて裏方のページへ押し出す', async () => {
    const { store, alertChannel } = await setupPlayingCasualTrack()
    const jev = createFakeJev({ choice: 't1', confidence: BGM_CONFIDENCE_THRESHOLD })

    await chooseBgm({ store, jev, alerts: alertChannel.namespace, now: NOW, ...material })

    expect(jev.usages).toEqual(['bgm'])
    // 音量は配信者が決めたまま変えない
    expect(await loadBgmPlayback(store)).toEqual({ mediaId: hypeTrack.mediaId, volume: 0.4 })
    expect(await loadBgmSwitchedAt(store)).toBe(NOW)
    expect(alertChannel.pushedBgm).toEqual([
      {
        track: {
          mediaId: hypeTrack.mediaId,
          title: '全力疾走',
          credit: '音楽: DOVA-SYNDROME',
          creditUrl: 'https://dova-s.jp/',
          url: `/api/media/media-moriagari?key=${ISSUED_KEY}`,
        },
        volume: 0.4,
      },
    ])
  })

  it('確信度がしきい値に届かなければ切り替えない（誤った切り替えは配信の雰囲気を壊すため）', async () => {
    const { store, alertChannel } = await setupPlayingCasualTrack()
    const jev = createFakeJev({ choice: 't1', confidence: BGM_CONFIDENCE_THRESHOLD - 0.01 })

    await chooseBgm({ store, jev, alerts: alertChannel.namespace, now: NOW, ...material })

    expect(await loadBgmPlayback(store)).toEqual({ mediaId: casualTrack.mediaId, volume: 0.4 })
    expect(alertChannel.pushedBgm).toEqual([])
  })

  it('いま流している曲が選ばれたら、何もしない（頭から流れ直させない）', async () => {
    const { store, alertChannel } = await setupPlayingCasualTrack()
    const previousSwitchedAt = NOW - BGM_SWITCH_COOLDOWN_MS
    const jev = createFakeJev({ choice: 't0', confidence: 0.99 })

    await chooseBgm({ store, jev, alerts: alertChannel.namespace, now: NOW, ...material })

    expect(await loadBgmSwitchedAt(store)).toBe(previousSwitchedAt)
    expect(alertChannel.pushedBgm).toEqual([])
  })

  it('設定がオフなら Jev を呼ばない', async () => {
    const { store, alertChannel } = await setupPlayingCasualTrack()
    await saveBgmSettings(store, { judgeWithJev: false })
    const jev = createFakeJev(new Error('呼ばれないはず'))

    await chooseBgm({ store, jev, alerts: alertChannel.namespace, now: NOW, ...material })

    expect(jev.requests).toEqual([])
  })

  it('BGMを止めているなら Jev を呼ばない（配信者が止めたものを勝手に流し始めない）', async () => {
    const { store, alertChannel } = await setupPlayingCasualTrack()
    await saveBgmPlayback(store, { mediaId: null, volume: 0.4 })
    const jev = createFakeJev(new Error('呼ばれないはず'))

    await chooseBgm({ store, jev, alerts: alertChannel.namespace, now: NOW, ...material })

    expect(jev.requests).toEqual([])
  })

  it('切り替えてから控える時間が経つまでは Jev を呼ばない（手で選んだ直後も同じ）', async () => {
    const { store, alertChannel } = await setupPlayingCasualTrack({ switchedAt: NOW - BGM_SWITCH_COOLDOWN_MS + 1 })
    const jev = createFakeJev(new Error('呼ばれないはず'))

    await chooseBgm({ store, jev, alerts: alertChannel.namespace, now: NOW, ...material })

    expect(jev.requests).toEqual([])
  })

  it('まだ一度も切り替えた記録が無ければ、控えずに Jev を呼ぶ', async () => {
    const store = createFakeStore({ 'overlay-key': ISSUED_KEY })
    await saveBgmTracks(store, [casualTrack, hypeTrack])
    await saveBgmPlayback(store, { mediaId: casualTrack.mediaId, volume: 0.4 })
    await saveBgmSettings(store, { judgeWithJev: true })
    const jev = createFakeJev({ choice: 't0', confidence: 0.9 })

    await chooseBgm({ store, jev, alerts: createFakeAlertChannel().namespace, now: NOW, ...material })

    expect(jev.requests).toHaveLength(1)
  })

  it('いま流している曲のほかに候補が無ければ Jev を呼ばない', async () => {
    const { store, alertChannel } = await setupPlayingCasualTrack({ tracks: [casualTrack, undescribedTrack] })
    const jev = createFakeJev(new Error('呼ばれないはず'))

    await chooseBgm({ store, jev, alerts: alertChannel.namespace, now: NOW, ...material })

    expect(jev.requests).toEqual([])
  })

  it('判定のあいだに配信者が手で曲を切り替えていたら、上書きしない', async () => {
    const { store, alertChannel } = await setupPlayingCasualTrack()
    const jev: JevClient = {
      decide: async <Qs extends Readonly<Record<string, JevQuestion>>>(): Promise<JevAnswers<Qs>> => {
        // 判定を待っているあいだに、配信者が管理画面で止めた
        await saveBgmPlayback(store, { mediaId: null, volume: 0.4 })
        return { track: { choice: 't1', confidence: 0.99 } } as JevAnswers<Qs>
      },
    }

    await chooseBgm({ store, jev, alerts: alertChannel.namespace, now: NOW, ...material })

    expect(await loadBgmPlayback(store)).toEqual({ mediaId: null, volume: 0.4 })
    expect(alertChannel.pushedBgm).toEqual([])
  })

  it('判定のあいだに配信者が自動の切り替えを切っていたら、切り替えない', async () => {
    const { store, alertChannel } = await setupPlayingCasualTrack()
    const jev: JevClient = {
      decide: async <Qs extends Readonly<Record<string, JevQuestion>>>(): Promise<JevAnswers<Qs>> => {
        // 判定を待っているあいだに、配信者が管理画面で自動の切り替えを切った
        await saveBgmSettings(store, { judgeWithJev: false })
        return { track: { choice: 't1', confidence: 0.99 } } as JevAnswers<Qs>
      },
    }

    await chooseBgm({ store, jev, alerts: alertChannel.namespace, now: NOW, ...material })

    expect(await loadBgmPlayback(store)).toEqual({ mediaId: casualTrack.mediaId, volume: 0.4 })
    expect(alertChannel.pushedBgm).toEqual([])
  })

  it('確信度が返ってこなければ、切り替えずに投げる（しきい値と比べられないことを黙らない）', async () => {
    const { store, alertChannel } = await setupPlayingCasualTrack()
    const jev = createFakeJev({ choice: 't1', confidence: null })

    await expect(chooseBgm({ store, jev, alerts: alertChannel.namespace, now: NOW, ...material })).rejects.toThrow('確信度')
    expect(await loadBgmPlayback(store)).toEqual({ mediaId: casualTrack.mediaId, volume: 0.4 })
  })

  it('Jev が失敗したら、曲を変えずにそのまま投げる', async () => {
    const { store, alertChannel } = await setupPlayingCasualTrack()
    const jev = createFakeJev(new Error('Jev が失敗を返しました（402）'))

    await expect(chooseBgm({ store, jev, alerts: alertChannel.namespace, now: NOW, ...material })).rejects.toThrow('402')
    expect(await loadBgmPlayback(store)).toEqual({ mediaId: casualTrack.mediaId, volume: 0.4 })
    expect(alertChannel.pushedBgm).toEqual([])
  })
})
