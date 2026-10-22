/**
 * 人形の獲得の素材の順番待ち（queue.ts）のテスト
 *
 * 誰でも打てる !人形・!人形ランキング で順番待ちが伸び、獲得の演出が遅れたり古い所持数を延々と流したりしないよう、
 * 次のとおり並べることを確かめる。
 * - 獲得は必ず後ろに並べる（人形を渡した出来事は落とさない）
 * - 同じ人の所持数・ランキングがもう待っていれば、新しいもので置き換える（2度流さない）
 * - 所持数とランキングは、待っているものが上限に達していれば並べない
 */
import { describe, expect, it } from 'vitest'
import type { DollAwardCall, DollAwardMessage, DollRankingCall, DollStandingCall } from './call'
import { MAX_WAITING_DOLL_MESSAGES, enqueueDollAwardMessage } from './queue'

const figure = { name: 'クマ人形', imageUrl: '/api/media/image-bear?key=k' }

const award = (id: string): DollAwardCall => ({ type: 'award', id, userName: '花子', kind: 'normal', count: 1, doll: figure })
const standing = (id: string, userId: string, userName = '花子', count = 1): DollStandingCall => ({
  type: 'standing',
  id,
  userId,
  userName,
  normal: { ...figure, count },
  super: { ...figure, count: 0 },
})
const ranking = (id: string): DollRankingCall => ({ type: 'ranking', id, normal: figure, super: figure, entries: [] })

const ids = (queue: readonly DollAwardMessage[]): string[] => queue.map((message) => message.id)

describe('enqueueDollAwardMessage', () => {
  it('届いた順に後ろへ並べる', () => {
    expect(ids(enqueueDollAwardMessage([award('a1')], standing('s1', '花子')))).toEqual(['a1', 's1'])
  })

  it('同じ人の所持数がもう待っていれば、その場所で新しいものに置き換える', () => {
    const queue = enqueueDollAwardMessage([standing('s1', '1001', '花子', 1), award('a1')], standing('s2', '1001', '花子', 2))

    expect(ids(queue)).toEqual(['s2', 'a1'])
  })

  it('表示名が同じでも、別の人の所持数は置き換えない', () => {
    const queue = enqueueDollAwardMessage([standing('s1', '1001', '花子')], standing('s2', '1002', '花子'))

    expect(ids(queue)).toEqual(['s1', 's2'])
  })

  it('ランキングがもう待っていれば、新しいものに置き換える', () => {
    expect(ids(enqueueDollAwardMessage([ranking('r1'), award('a1')], ranking('r2')))).toEqual(['r2', 'a1'])
  })

  it('待っているものが上限に達していれば、所持数とランキングは並べない', () => {
    const full = Array.from({ length: MAX_WAITING_DOLL_MESSAGES }, (_, index) => standing(`s${String(index)}`, `10${String(index)}`, `視聴者${String(index)}`))

    expect(enqueueDollAwardMessage(full, standing('new', '2000', '太郎'))).toBe(full)
    expect(enqueueDollAwardMessage(full, ranking('r1'))).toBe(full)
  })

  it('獲得は上限に達していても並べる', () => {
    const full = Array.from({ length: MAX_WAITING_DOLL_MESSAGES }, (_, index) => standing(`s${String(index)}`, `10${String(index)}`, `視聴者${String(index)}`))

    expect(ids(enqueueDollAwardMessage(full, award('a1'))).at(-1)).toBe('a1')
  })
})
