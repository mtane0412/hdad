/**
 * ポモドーロの休憩中のBGMの切り替え（pomodoro-bgm.ts）のテスト
 *
 * 休憩に入ったら設定した休憩の曲へ切り替え（休憩のあいだに次の曲へ進まないよう、繰り返しにする）、
 * 休憩が明けたら休憩の前に流していた曲と繰り返しの設定へ戻す。音量とシャッフルは配信者が変えたものをそのまま使う。
 * どちらも裏方のページへ押し出し、切り替えた時刻を記録する（Jev がすぐ曲を変えないようにする）ことを確かめる。
 */
import { describe, expect, it } from 'vitest'
import { saveBgmPlayback, saveBgmTracks, loadBgmPlayback, loadBgmSwitchedAt, type BgmTrack } from './bgm-config'
import { BGM_SWITCH_COOLDOWN_MS } from './bgm-jev'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeStore } from './fake-store'
import { restoreBgmAfterBreak, switchToBreakBgm } from './pomodoro-bgm'
import { BREAK_MS } from '../src/pomodoro/phase'

const now = Date.parse('2026-10-03T12:25:00Z')

const track = (mediaId: string, title: string): BgmTrack => ({ mediaId, title, credit: 'フリーBGM配布所', creditUrl: '', mood: '', scene: '' })
const workTrack = track('media-作業用ピアノ', '作業用ピアノ')
const breakTrack = track('media-休憩のカフェ', '休憩のカフェ')

/** 作業用の曲を、繰り返しを切って流している状態を作る */
const createStore = async () => {
  const store = createFakeStore({ 'overlay-key': 'issued-overlay-key-0123456789abcdefghij' })
  await saveBgmTracks(store, [workTrack, breakTrack])
  await saveBgmPlayback(store, { mediaId: workTrack.mediaId, volume: 0.4, repeat: false, shuffle: true })
  return store
}

describe('switchToBreakBgm', () => {
  it('休憩の曲を繰り返しで流し、休憩の前に流していた曲と繰り返しの設定を返す', async () => {
    const store = await createStore()
    const alerts = createFakeAlertChannel()

    const before = await switchToBreakBgm(store, alerts.namespace, breakTrack.mediaId, now)

    expect(before).toEqual({ mediaId: workTrack.mediaId, repeat: false })
    // 音量とシャッフルは変えない
    expect(await loadBgmPlayback(store)).toEqual({ mediaId: breakTrack.mediaId, volume: 0.4, repeat: true, shuffle: true })
    expect(alerts.pushedBgm.map((pushed) => pushed.track?.title)).toEqual(['休憩のカフェ'])
    expect(await loadBgmSwitchedAt(store)).toBe(now)
  })

  it('止めていたときも休憩の曲を流し、休憩の前は「止めていた」と返す', async () => {
    const store = await createStore()
    await saveBgmPlayback(store, { mediaId: null, volume: 0.4, repeat: false, shuffle: false })

    expect(await switchToBreakBgm(store, createFakeAlertChannel().namespace, breakTrack.mediaId, now)).toEqual({ mediaId: null, repeat: false })
    expect((await loadBgmPlayback(store)).mediaId).toBe(breakTrack.mediaId)
  })

  it('休憩の曲がBGMの一覧から消えていれば、切り替えずに投げる（黙って無音にしない）', async () => {
    const store = await createStore()
    await saveBgmTracks(store, [workTrack])
    const alerts = createFakeAlertChannel()

    await expect(switchToBreakBgm(store, alerts.namespace, breakTrack.mediaId, now)).rejects.toThrow(breakTrack.mediaId)
    expect((await loadBgmPlayback(store)).mediaId).toBe(workTrack.mediaId)
    expect(alerts.pushedBgm).toEqual([])
  })

  it('休憩は、Jev が曲の切り替えを控える時間より短い（休憩の曲を Jev に変えさせないため）', () => {
    // 休憩に入るときに切り替えた時刻を記録するので、休憩のあいだは Jev の切り替えが控えられる
    expect(BREAK_MS).toBeLessThanOrEqual(BGM_SWITCH_COOLDOWN_MS)
  })
})

describe('restoreBgmAfterBreak', () => {
  it('休憩の前に流していた曲と繰り返しの設定へ戻す（音量とシャッフルは休憩中に変えたものを使う）', async () => {
    const store = await createStore()
    // 休憩中に配信者が音量を下げた
    await saveBgmPlayback(store, { mediaId: breakTrack.mediaId, volume: 0.2, repeat: true, shuffle: true })
    const alerts = createFakeAlertChannel()
    const later = now + BREAK_MS

    await restoreBgmAfterBreak(store, alerts.namespace, { mediaId: workTrack.mediaId, repeat: false }, later)

    expect(await loadBgmPlayback(store)).toEqual({ mediaId: workTrack.mediaId, volume: 0.2, repeat: false, shuffle: true })
    expect(alerts.pushedBgm.map((pushed) => pushed.track?.title)).toEqual(['作業用ピアノ'])
    expect(await loadBgmSwitchedAt(store)).toBe(later)
  })

  it('休憩の前に止めていたなら、止める', async () => {
    const store = await createStore()
    const alerts = createFakeAlertChannel()

    await restoreBgmAfterBreak(store, alerts.namespace, { mediaId: null, repeat: false }, now)

    expect((await loadBgmPlayback(store)).mediaId).toBeNull()
    expect(alerts.pushedBgm.map((pushed) => pushed.track)).toEqual([null])
  })

  it('休憩の前の曲がBGMの一覧から消えていれば、戻さずに投げる', async () => {
    const store = await createStore()
    await saveBgmTracks(store, [breakTrack])
    await saveBgmPlayback(store, { mediaId: breakTrack.mediaId, volume: 0.4, repeat: true, shuffle: false })

    await expect(restoreBgmAfterBreak(store, createFakeAlertChannel().namespace, { mediaId: workTrack.mediaId, repeat: false }, now)).rejects.toThrow(
      workTrack.mediaId,
    )
    expect((await loadBgmPlayback(store)).mediaId).toBe(breakTrack.mediaId)
  })
})
