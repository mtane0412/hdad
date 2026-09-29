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

const 現在時刻 = Date.parse('2026-09-29T12:00:00Z')
const 発行済みのキー = 'issued-overlay-key-0123456789abcdefghij'

/** 雑談のときに流したい、落ち着いた曲 */
const 雑談の曲: BgmTrack = {
  mediaId: 'media-zatsudan',
  title: 'ひだまりの午後',
  credit: '音楽: 甘茶の音楽工房',
  creditUrl: 'https://amachamusic.chagasi.com/',
  mood: 'ゆったりしたアコースティック',
  scene: '雑談・作業配信',
}

/** ゲームで盛り上がったときに流したい曲 */
const 盛り上がる曲: BgmTrack = {
  mediaId: 'media-moriagari',
  title: '全力疾走',
  credit: '音楽: DOVA-SYNDROME',
  creditUrl: 'https://dova-s.jp/',
  mood: 'テンポの速いロック',
  scene: 'ボス戦・盛り上がったとき',
}

/** 曲調も流したい場面も書いていない曲。Jev には選ばせようがない */
const 説明の無い曲: BgmTrack = {
  mediaId: 'media-setsumei-nashi',
  title: '名前だけの曲',
  credit: '音楽: だれか',
  creditUrl: '',
  mood: '',
  scene: '',
}

const 材料 = {
  summary: '雑談のあと、ホラーゲームを始めてボス戦に入った',
  transcript: ['うわ、ボス来た', 'これ勝てるかな', 'いくぞ！'],
}

/** Jev の代役。渡された注文を控え、決めた答えを返す（失敗させることもできる） */
const Jevの代役 = (
  答え: ChoiceAnswer | Error,
): JevClient & { 注文: JevRequest<Record<string, JevQuestion>>[]; 箇所: JevUsage[] } => {
  const 注文: JevRequest<Record<string, JevQuestion>>[] = []
  const 箇所: JevUsage[] = []
  return {
    注文,
    箇所,
    decide: async <Qs extends Readonly<Record<string, JevQuestion>>>(usage: JevUsage, request: JevRequest<Qs>): Promise<JevAnswers<Qs>> => {
      箇所.push(usage)
      注文.push(request)
      if (答え instanceof Error) throw 答え
      return { track: 答え } as JevAnswers<Qs>
    },
  }
}

/** 雑談の曲を流していて、Jev に選ばせる設定を入れ、しばらく切り替えていない状態を用意する */
const 雑談の曲を流している = async (overrides: { tracks?: readonly BgmTrack[]; switchedAt?: number } = {}) => {
  const store = createFakeStore({ 'overlay-key': 発行済みのキー })
  await saveBgmTracks(store, overrides.tracks ?? [雑談の曲, 盛り上がる曲])
  await saveBgmPlayback(store, { mediaId: 雑談の曲.mediaId, volume: 0.4 })
  await saveBgmSettings(store, { judgeWithJev: true })
  await saveBgmSwitchedAt(store, overrides.switchedAt ?? 現在時刻 - BGM_SWITCH_COOLDOWN_MS)
  const 配送 = createFakeAlertChannel()
  return { store, 配送 }
}

describe('bgmCandidatesOf', () => {
  it('曲調か流したい場面を書いてある曲と、いま流している曲を候補にする', () => {
    expect(bgmCandidatesOf([雑談の曲, 説明の無い曲, 盛り上がる曲], 雑談の曲.mediaId)).toEqual([雑談の曲, 盛り上がる曲])
  })

  it('いま流している曲は、説明が無くても候補に入れる（「いまの曲のまま」を選べるようにするため）', () => {
    expect(bgmCandidatesOf([雑談の曲, 説明の無い曲], 説明の無い曲.mediaId)).toEqual([雑談の曲, 説明の無い曲])
  })
})

describe('buildBgmRequest', () => {
  it('あらすじと直近の発話を材料にし、曲ごとの曲調・流したい場面を選択肢の説明にする', () => {
    const request = buildBgmRequest(材料, [雑談の曲, 盛り上がる曲], 雑談の曲.mediaId)

    expect(request.state).toEqual({ summary: 材料.summary, transcript: 材料.transcript })
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
    const { store, 配送 } = await 雑談の曲を流している()
    const jev = Jevの代役({ choice: 't1', confidence: BGM_CONFIDENCE_THRESHOLD })

    await chooseBgm({ store, jev, alerts: 配送.namespace, now: 現在時刻, ...材料 })

    expect(jev.箇所).toEqual(['bgm'])
    // 音量は配信者が決めたまま変えない
    expect(await loadBgmPlayback(store)).toEqual({ mediaId: 盛り上がる曲.mediaId, volume: 0.4 })
    expect(await loadBgmSwitchedAt(store)).toBe(現在時刻)
    expect(配送.押し出されたBGM).toEqual([
      {
        track: {
          mediaId: 盛り上がる曲.mediaId,
          title: '全力疾走',
          credit: '音楽: DOVA-SYNDROME',
          creditUrl: 'https://dova-s.jp/',
          url: `/api/media/media-moriagari?key=${発行済みのキー}`,
        },
        volume: 0.4,
      },
    ])
  })

  it('確信度がしきい値に届かなければ切り替えない（誤った切り替えは配信の雰囲気を壊すため）', async () => {
    const { store, 配送 } = await 雑談の曲を流している()
    const jev = Jevの代役({ choice: 't1', confidence: BGM_CONFIDENCE_THRESHOLD - 0.01 })

    await chooseBgm({ store, jev, alerts: 配送.namespace, now: 現在時刻, ...材料 })

    expect(await loadBgmPlayback(store)).toEqual({ mediaId: 雑談の曲.mediaId, volume: 0.4 })
    expect(配送.押し出されたBGM).toEqual([])
  })

  it('いま流している曲が選ばれたら、何もしない（頭から流れ直させない）', async () => {
    const { store, 配送 } = await 雑談の曲を流している()
    const 前に切り替えた時刻 = 現在時刻 - BGM_SWITCH_COOLDOWN_MS
    const jev = Jevの代役({ choice: 't0', confidence: 0.99 })

    await chooseBgm({ store, jev, alerts: 配送.namespace, now: 現在時刻, ...材料 })

    expect(await loadBgmSwitchedAt(store)).toBe(前に切り替えた時刻)
    expect(配送.押し出されたBGM).toEqual([])
  })

  it('設定がオフなら Jev を呼ばない', async () => {
    const { store, 配送 } = await 雑談の曲を流している()
    await saveBgmSettings(store, { judgeWithJev: false })
    const jev = Jevの代役(new Error('呼ばれないはず'))

    await chooseBgm({ store, jev, alerts: 配送.namespace, now: 現在時刻, ...材料 })

    expect(jev.注文).toEqual([])
  })

  it('BGMを止めているなら Jev を呼ばない（配信者が止めたものを勝手に流し始めない）', async () => {
    const { store, 配送 } = await 雑談の曲を流している()
    await saveBgmPlayback(store, { mediaId: null, volume: 0.4 })
    const jev = Jevの代役(new Error('呼ばれないはず'))

    await chooseBgm({ store, jev, alerts: 配送.namespace, now: 現在時刻, ...材料 })

    expect(jev.注文).toEqual([])
  })

  it('切り替えてから控える時間が経つまでは Jev を呼ばない（手で選んだ直後も同じ）', async () => {
    const { store, 配送 } = await 雑談の曲を流している({ switchedAt: 現在時刻 - BGM_SWITCH_COOLDOWN_MS + 1 })
    const jev = Jevの代役(new Error('呼ばれないはず'))

    await chooseBgm({ store, jev, alerts: 配送.namespace, now: 現在時刻, ...材料 })

    expect(jev.注文).toEqual([])
  })

  it('まだ一度も切り替えた記録が無ければ、控えずに Jev を呼ぶ', async () => {
    const store = createFakeStore({ 'overlay-key': 発行済みのキー })
    await saveBgmTracks(store, [雑談の曲, 盛り上がる曲])
    await saveBgmPlayback(store, { mediaId: 雑談の曲.mediaId, volume: 0.4 })
    await saveBgmSettings(store, { judgeWithJev: true })
    const jev = Jevの代役({ choice: 't0', confidence: 0.9 })

    await chooseBgm({ store, jev, alerts: createFakeAlertChannel().namespace, now: 現在時刻, ...材料 })

    expect(jev.注文).toHaveLength(1)
  })

  it('いま流している曲のほかに候補が無ければ Jev を呼ばない', async () => {
    const { store, 配送 } = await 雑談の曲を流している({ tracks: [雑談の曲, 説明の無い曲] })
    const jev = Jevの代役(new Error('呼ばれないはず'))

    await chooseBgm({ store, jev, alerts: 配送.namespace, now: 現在時刻, ...材料 })

    expect(jev.注文).toEqual([])
  })

  it('判定のあいだに配信者が手で曲を切り替えていたら、上書きしない', async () => {
    const { store, 配送 } = await 雑談の曲を流している()
    const jev: JevClient = {
      decide: async <Qs extends Readonly<Record<string, JevQuestion>>>(): Promise<JevAnswers<Qs>> => {
        // 判定を待っているあいだに、配信者が管理画面で止めた
        await saveBgmPlayback(store, { mediaId: null, volume: 0.4 })
        return { track: { choice: 't1', confidence: 0.99 } } as JevAnswers<Qs>
      },
    }

    await chooseBgm({ store, jev, alerts: 配送.namespace, now: 現在時刻, ...材料 })

    expect(await loadBgmPlayback(store)).toEqual({ mediaId: null, volume: 0.4 })
    expect(配送.押し出されたBGM).toEqual([])
  })

  it('確信度が返ってこなければ、切り替えずに投げる（しきい値と比べられないことを黙らない）', async () => {
    const { store, 配送 } = await 雑談の曲を流している()
    const jev = Jevの代役({ choice: 't1', confidence: null })

    await expect(chooseBgm({ store, jev, alerts: 配送.namespace, now: 現在時刻, ...材料 })).rejects.toThrow('確信度')
    expect(await loadBgmPlayback(store)).toEqual({ mediaId: 雑談の曲.mediaId, volume: 0.4 })
  })

  it('Jev が失敗したら、曲を変えずにそのまま投げる', async () => {
    const { store, 配送 } = await 雑談の曲を流している()
    const jev = Jevの代役(new Error('Jev が失敗を返しました（402）'))

    await expect(chooseBgm({ store, jev, alerts: 配送.namespace, now: 現在時刻, ...材料 })).rejects.toThrow('402')
    expect(await loadBgmPlayback(store)).toEqual({ mediaId: 雑談の曲.mediaId, volume: 0.4 })
    expect(配送.押し出されたBGM).toEqual([])
  })
})
