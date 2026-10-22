/**
 * 人形を渡して獲得の演出を押し出す（doll-award.ts）のテスト
 *
 * migrations/ のSQLをそのまま適用したメモリ上のSQLite（fake-database.ts）と、押し出しを貯める配送先の代役で、次の点を確かめる。
 * - 渡せたら、いまの人形の名前と画像（オーバーレイ用キーつきのURL）と、視聴者の名前・種類・個数を「人形の獲得」へ押し出すこと
 * - スーパー人形を渡したときは、スーパー人形の名前と画像を押し出すこと
 * - 同じきっかけの ID の再送では、2度押し出さないこと（台帳にも2度記録しない）
 * - 渡せなかったとき（いまの人形が無い）は押し出さずに投げること（記録は呼び出し側が行う）
 * - 押し出しに失敗しても投げず、渡したことは取り消さずに doll-award-failed を記録すること
 * - オーバーレイ用キーが無ければ画像のURLを作れないので、押し出さずに doll-award-failed を記録すること
 * - 押し出しの失敗の記録にも失敗したとき（D1 の不調）も投げないこと（渡せたのに「渡せなかった」と呼び出し側に記録させないため）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DollSetInput } from './doll'
import { grantDolls } from './doll-award'
import { DollChangeError, insertDollSet, readDollHoldings, selectCurrentDollSet } from './doll-store'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { listFailures } from './stats-store'

const NOW = Date.parse('2026-10-21T12:00:00.000Z')

/** クマの人形の組 */
const bears: DollSetInput = {
  normal: { name: 'クマ人形', mediaId: 'image-bear' },
  super: { name: 'スーパークマ人形', mediaId: 'image-super-bear' },
}

/** 視聴者「hanako」の Twitch のユーザー ID */
const HANAKO = '1001'

/** 漢字クイズの正解者に渡す1件（きっかけの ID は出題ごと） */
const kanjiQuizPrize = (sourceId: string) => ({ userId: HANAKO, userName: 'はなこ', kind: 'normal' as const, delta: 1, reason: 'kanjiQuiz' as const, sourceId })

let db: ReturnType<typeof createFakeDatabase>

beforeEach(() => {
  db = createFakeDatabase()
})

/** いまの人形を選んだ状態にする */
const chooseBears = async (): Promise<void> => {
  const set = await insertDollSet(db, bears, NOW)
  await selectCurrentDollSet(db, set.id)
}

describe('grantDolls', () => {
  it('渡せたら、いまの人形の名前・画像と視聴者の名前を「人形の獲得」へ押し出す', async () => {
    await chooseBears()
    const alerts = createFakeAlertChannel()
    const env = { DB: db, STORE: createFakeStore({ 'overlay-key': 'secret' }), ALERTS: alerts.namespace }

    await grantDolls(env, NOW, kanjiQuizPrize('kanjiQuiz:1'))

    expect(alerts.pushedDollAwards).toEqual([
      {
        type: 'award',
        id: 'kanjiQuiz:1',
        userName: 'はなこ',
        kind: 'normal',
        count: 1,
        doll: { name: 'クマ人形', imageUrl: '/api/media/image-bear?key=secret' },
      },
    ])
    expect((await readDollHoldings(db))[0]?.normal).toBe(1)
  })

  it('スーパー人形を3つ渡したときは、スーパー人形の名前と画像と個数を押し出す', async () => {
    await chooseBears()
    const alerts = createFakeAlertChannel()
    const env = { DB: db, STORE: createFakeStore({ 'overlay-key': 'secret' }), ALERTS: alerts.namespace }

    await grantDolls(
      env,
      NOW,
      { userId: HANAKO, userName: 'はなこ', kind: 'super', delta: 3, reason: 'trigger', triggerKind: 'reward', sourceId: 'trigger:m1:dollGrant:0' },
    )

    expect(alerts.pushedDollAwards).toEqual([
      {
        type: 'award',
        id: 'trigger:m1:dollGrant:0',
        userName: 'はなこ',
        kind: 'super',
        count: 3,
        doll: { name: 'スーパークマ人形', imageUrl: '/api/media/image-super-bear?key=secret' },
      },
    ])
  })

  it('同じきっかけの ID の再送では、2度押し出さない', async () => {
    await chooseBears()
    const alerts = createFakeAlertChannel()
    const env = { DB: db, STORE: createFakeStore({ 'overlay-key': 'secret' }), ALERTS: alerts.namespace }

    await grantDolls(env, NOW, kanjiQuizPrize('kanjiQuiz:1'))
    await grantDolls(env, NOW, kanjiQuizPrize('kanjiQuiz:1'))

    expect(alerts.pushedDollAwards).toHaveLength(1)
  })

  it('いまの人形が無くて渡せなかったときは、押し出さずに投げる', async () => {
    const alerts = createFakeAlertChannel()
    const env = { DB: db, STORE: createFakeStore({ 'overlay-key': 'secret' }), ALERTS: alerts.namespace }

    await expect(grantDolls(env, NOW, kanjiQuizPrize('kanjiQuiz:1'))).rejects.toBeInstanceOf(DollChangeError)
    expect(alerts.pushedDollAwards).toEqual([])
  })

  it('押し出しに失敗しても投げず、渡したことは残して doll-award-failed を記録する', async () => {
    await chooseBears()
    const alerts = createFakeAlertChannel({ shouldFail: true })
    const env = { DB: db, STORE: createFakeStore({ 'overlay-key': 'secret' }), ALERTS: alerts.namespace }

    await grantDolls(env, NOW, kanjiQuizPrize('kanjiQuiz:1'))

    expect((await readDollHoldings(db))[0]?.normal).toBe(1)
    const failures = await listFailures(db)
    expect(failures.map(({ code }) => code)).toEqual(['doll-award-failed'])
    expect(failures[0]?.message).toContain('はなこ')
  })

  it('オーバーレイ用キーが無ければ、押し出さずに doll-award-failed を記録する', async () => {
    await chooseBears()
    const alerts = createFakeAlertChannel()
    const env = { DB: db, STORE: createFakeStore(), ALERTS: alerts.namespace }

    await grantDolls(env, NOW, kanjiQuizPrize('kanjiQuiz:1'))

    expect(alerts.pushedDollAwards).toEqual([])
    expect((await listFailures(db)).map(({ code }) => code)).toEqual(['doll-award-failed'])
  })

  it('押し出しの失敗の記録にも失敗したときも投げず、渡したことは残す', async () => {
    // 前提: 配送先が失敗し、失敗の記録（batch）も D1 の不調で失敗する
    await chooseBears()
    const alerts = createFakeAlertChannel({ shouldFail: true })
    const brokenBatch = Object.assign(Object.create(db) as typeof db, {
      batch: () => Promise.reject(new Error('D1 が応答しません')),
    })
    const env = { DB: brokenBatch, STORE: createFakeStore({ 'overlay-key': 'secret' }), ALERTS: alerts.namespace }
    // 記録の失敗は Worker のログに残す（テストの出力を汚さないよう黙らせる）
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(grantDolls(env, NOW, kanjiQuizPrize('kanjiQuiz:1'))).resolves.toBeUndefined()

    expect((await readDollHoldings(db))[0]?.normal).toBe(1)
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })
})
