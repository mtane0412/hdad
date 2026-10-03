/**
 * 作業ログの1行の読み取りと重ね方（entry.ts）のテスト
 *
 * 合成ページは「開いたときの読み出し」と「押し出された1行」の両方から行を受け取るので、次の点を確かめる。
 * - 押し出された文字列を1行として読み、形が違えば投げること（Fail-Fast）
 * - 同じ id の行を重ねて1行にし、新しい順に並べ、上限で古いものを落とすこと
 * - 時刻を配信画面の時計と同じ「時:分」で出すこと
 */
import { describe, expect, it } from 'vitest'
import { clockOf, mergeEntries, parseWorkLogEntry, type WorkLogEntry } from './entry'

const commit: WorkLogEntry = { id: 'github:delivery-1', kind: 'commit', at: '2026-10-03T12:10:00.000Z', text: '署名の確認を足す' }
const chapter: WorkLogEntry = { id: 'chapter:2026-10-03T12:00:00.000Z', kind: 'chapter', at: '2026-10-03T12:00:00.000Z', text: 'Webhookの署名を確かめる' }
const merge: WorkLogEntry = { id: 'github:delivery-2', kind: 'merge', at: '2026-10-03T12:40:00.000Z', text: '#212 GitHub の Webhook を受ける' }

describe('parseWorkLogEntry', () => {
  it('押し出された文字列を、作業ログの1行として読む', () => {
    expect(parseWorkLogEntry(JSON.stringify(merge))).toEqual(merge)
  })

  it('JSONとして読めなければ投げる', () => {
    expect(() => parseWorkLogEntry('壊れた文字列')).toThrow('JSON')
  })

  it('知らない種類の行は投げる（機械の作った行と実際の出来事を取り違えて出さないため）', () => {
    expect(() => parseWorkLogEntry(JSON.stringify({ ...merge, kind: 'unknown' }))).toThrow('作業ログ')
  })
})

describe('mergeEntries', () => {
  it('新しい行を加え、新しい順に並べる', () => {
    expect(mergeEntries([commit, chapter], [merge], 20)).toEqual([merge, commit, chapter])
  })

  it('同じ id の行は1行に重ねる（再送や、読み直しと押し出しの行き違いで2行にしない）', () => {
    expect(mergeEntries([merge, commit], [merge], 20)).toEqual([merge, commit])
  })

  it('上限より多ければ、古いものから落とす', () => {
    expect(mergeEntries([commit, chapter], [merge], 2)).toEqual([merge, commit])
  })
})

describe('clockOf', () => {
  it('配信者の時計（ブラウザの時刻）で「時:分」にする', () => {
    const at = new Date(2026, 9, 3, 9, 5).toISOString()

    expect(clockOf(at)).toBe('09:05')
  })
})
