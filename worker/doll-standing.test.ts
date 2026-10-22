/**
 * 人形の所持数とランキングを合成ページへ出す（doll-standing.ts）のテスト
 *
 * migrations/ のSQLをそのまま適用したメモリ上のSQLite（fake-database.ts）と、押し出しを貯める配送先の代役で、次の点を確かめる。
 * - 1人ぶんの所持数は、いまの人形のふつう・スーパーの名前と画像（オーバーレイ用キーつきのURL）と個数を、名前つきで押し出すこと
 * - ランキングは、いまの人形の名前と画像と、点数の高い順の上位（DOLL_RANKING_LIMIT 人まで）を押し出すこと
 * - いまの人形が無い・オーバーレイ用キーが無い・配送先が失敗した、ときは黙らずに投げること（記録や応答は呼び出し側が行う）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { DOLL_RANKING_LIMIT, type DollSetInput } from './doll'
import { DollChangeError, changeDolls, insertDollSet, selectCurrentDollSet } from './doll-store'
import { showDollRanking, showDollStanding } from './doll-standing'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'

const NOW = Date.parse('2026-10-22T12:00:00.000Z')

/** クマの人形の組 */
const bears: DollSetInput = {
  normal: { name: 'クマ人形', mediaId: 'image-bear' },
  super: { name: 'スーパークマ人形', mediaId: 'image-super-bear' },
}

/** 視聴者「hanako」の Twitch のユーザー ID */
const HANAKO = '1001'
/** 視聴者「taro」の Twitch のユーザー ID */
const TARO = '1002'

let db: ReturnType<typeof createFakeDatabase>

beforeEach(() => {
  db = createFakeDatabase()
})

/** いまの人形を選んだ状態にする */
const chooseBears = async (): Promise<void> => {
  const set = await insertDollSet(db, bears, NOW)
  await selectCurrentDollSet(db, set.id)
}

/** 手で渡す（台帳を用意するため） */
const give = (userId: string, userName: string, kind: 'normal' | 'super', delta: number, sourceId: string) =>
  changeDolls(db, { userId, userName, kind, delta, reason: 'manual', sourceId }, NOW)

/** オーバーレイ用キーを発行済みの環境 */
const envWith = (alerts: ReturnType<typeof createFakeAlertChannel>, store = createFakeStore({ 'overlay-key': 'secret' })) => ({
  DB: db,
  STORE: store,
  ALERTS: alerts.namespace,
})

describe('showDollStanding', () => {
  it('いまの人形のふつう・スーパーの名前・画像・個数を、視聴者の名前つきで押し出す', async () => {
    // 前提: はなこはふつう2つ・スーパー1つを持っている
    await chooseBears()
    await give(HANAKO, 'はなこ', 'normal', 2, 'manual-1')
    await give(HANAKO, 'はなこ', 'super', 1, 'manual-2')
    const alerts = createFakeAlertChannel()

    await showDollStanding(envWith(alerts), HANAKO, 'はなこ')

    expect(alerts.pushedDollAwards).toEqual([
      {
        type: 'standing',
        id: expect.any(String),
        userId: HANAKO,
        userName: 'はなこ',
        normal: { name: 'クマ人形', imageUrl: '/api/media/image-bear?key=secret', count: 2 },
        super: { name: 'スーパークマ人形', imageUrl: '/api/media/image-super-bear?key=secret', count: 1 },
      },
    ])
  })

  it('持っていない人も 0 つとして押し出す', async () => {
    await chooseBears()
    const alerts = createFakeAlertChannel()

    await showDollStanding(envWith(alerts), TARO, 'たろう')

    expect(alerts.pushedDollAwards).toEqual([
      expect.objectContaining({ type: 'standing', userName: 'たろう', normal: expect.objectContaining({ count: 0 }), super: expect.objectContaining({ count: 0 }) }),
    ])
  })

  it('いまの人形が無ければ押し出さずに DollChangeError を投げる', async () => {
    const alerts = createFakeAlertChannel()

    await expect(showDollStanding(envWith(alerts), HANAKO, 'はなこ')).rejects.toBeInstanceOf(DollChangeError)
    expect(alerts.pushedDollAwards).toEqual([])
  })

  it('オーバーレイ用キーが無ければ、押し出さずに投げる', async () => {
    await chooseBears()
    const alerts = createFakeAlertChannel()

    await expect(showDollStanding(envWith(alerts, createFakeStore()), HANAKO, 'はなこ')).rejects.toThrow('オーバーレイ用キー')
    expect(alerts.pushedDollAwards).toEqual([])
  })

  it('配送先が失敗したら投げる', async () => {
    await chooseBears()
    const alerts = createFakeAlertChannel({ shouldFail: true })

    await expect(showDollStanding(envWith(alerts), HANAKO, 'はなこ')).rejects.toThrow()
  })
})

describe('showDollRanking', () => {
  it('いまの人形の名前・画像と、点数の高い順の上位を押し出す', async () => {
    // 前提: はなこ＝スーパー1つ（3点）、たろう＝ふつう1つ（1点）
    await chooseBears()
    await give(HANAKO, 'はなこ', 'super', 1, 'manual-1')
    await give(TARO, 'たろう', 'normal', 1, 'manual-2')
    const alerts = createFakeAlertChannel()

    await showDollRanking(envWith(alerts))

    expect(alerts.pushedDollAwards).toEqual([
      {
        type: 'ranking',
        id: expect.any(String),
        normal: { name: 'クマ人形', imageUrl: '/api/media/image-bear?key=secret' },
        super: { name: 'スーパークマ人形', imageUrl: '/api/media/image-super-bear?key=secret' },
        entries: [
          { rank: 1, userName: 'はなこ', normal: 0, super: 1, points: 3 },
          { rank: 2, userName: 'たろう', normal: 1, super: 0, points: 1 },
        ],
      },
    ])
  })

  it(`上位 ${String(DOLL_RANKING_LIMIT)} 人までを押し出す`, async () => {
    // 前提: 上限より1人多い人が、1人1つずつ持っている
    await chooseBears()
    for (let index = 0; index <= DOLL_RANKING_LIMIT; index += 1) {
      await give(`20${String(index)}`, `視聴者${String(index)}`, 'normal', 1, `manual-${String(index)}`)
    }
    const alerts = createFakeAlertChannel()

    await showDollRanking(envWith(alerts))

    const [pushed] = alerts.pushedDollAwards
    expect(pushed?.type === 'ranking' ? pushed.entries : []).toHaveLength(DOLL_RANKING_LIMIT)
  })

  it('いまの人形が無ければ押し出さずに DollChangeError を投げる', async () => {
    const alerts = createFakeAlertChannel()

    await expect(showDollRanking(envWith(alerts))).rejects.toBeInstanceOf(DollChangeError)
    expect(alerts.pushedDollAwards).toEqual([])
  })
})
