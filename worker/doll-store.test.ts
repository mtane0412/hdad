/**
 * 人形の組と増減の台帳の読み書き（doll-store.ts）のテスト
 *
 * migrations/ のSQLをそのまま適用したメモリ上のSQLite（fake-database.ts）で、次の点を確かめる。
 * - 組を追加・書き換え・削除でき、いまの人形は1組だけ選べること（選び直すと前の組は外れる）
 * - 台帳に記録のある組は消せないこと（集めた記録が宙に浮くため）
 * - 増減はいまの人形に記録され、所持数は組ごと・種類ごとの合計になること。配信中なら配信の ID も控えること
 * - 所持数より多くは減らせず、いまの人形が無ければ増減できないこと（どちらもエラーにして記録しない）
 * - 同じきっかけの ID の増減は2度記録しないこと（Twitch の通知の再送で二重に増減させないため）
 * - トリガーで渡した増減は、理由を trigger にして、どのトリガーの項目で渡したかを控えること（issue #419）
 * - 視聴者の記録を消すときに、その人の台帳も消せること
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { DollSet, DollSetInput } from './doll'
import {
  DollChangeError,
  changeDolls,
  deleteDollSet,
  deleteDollsOf,
  insertDollSet,
  readDollHoldings,
  readDollSets,
  selectCurrentDollSet,
  updateDollSet,
} from './doll-store'
import { createFakeDatabase } from './fake-database'

const NOW = Date.parse('2026-10-21T12:00:00.000Z')
const LATER = Date.parse('2026-10-21T12:30:00.000Z')

/** クマの人形の組 */
const bears: DollSetInput = {
  normal: { name: 'クマ人形', mediaId: 'image-bear' },
  super: { name: 'スーパークマ人形', mediaId: 'image-super-bear' },
}

/** ネコの人形の組 */
const cats: DollSetInput = {
  normal: { name: 'ネコ人形', mediaId: 'image-cat' },
  super: { name: 'スーパーネコ人形', mediaId: 'image-super-cat' },
}

/** 視聴者「hanako」の Twitch のユーザー ID */
const HANAKO = '1001'
/** 視聴者「taro」の Twitch のユーザー ID */
const TARO = '1002'

let db: ReturnType<typeof createFakeDatabase>

/** 組を追加し、いまの人形にする */
const addCurrentSet = async (input: DollSetInput): Promise<DollSet> => {
  const set = await insertDollSet(db, input, NOW)
  expect(await selectCurrentDollSet(db, set.id)).toBe(true)
  return set
}

/** 手での増減。きっかけの ID はテストごとに付ける */
const manual = (userId: string, kind: 'normal' | 'super', delta: number, sourceId: string) => ({ userId, kind, delta, reason: 'manual' as const, sourceId })

/** 増減が拒まれたときのエラーの種類を取り出す（拒まれなければテストを失敗させる） */
const rejectionOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
  } catch (error) {
    if (error instanceof DollChangeError) return error.code
    throw error
  }
  throw new Error('DollChangeError が投げられませんでした')
}

beforeEach(() => {
  db = createFakeDatabase()
})

describe('組の読み書き', () => {
  it('追加した組は、まだいまの人形ではない', async () => {
    const set = await insertDollSet(db, bears, NOW)

    expect(set).toEqual({ id: set.id, ...bears, current: false, updatedAt: '2026-10-21T12:00:00.000Z' })
    expect(await readDollSets(db)).toEqual([set])
  })

  it('いまの人形は1組だけで、選び直すと前の組は外れる。null で外せる', async () => {
    const bearSet = await insertDollSet(db, bears, NOW)
    const catSet = await insertDollSet(db, cats, NOW)

    await selectCurrentDollSet(db, bearSet.id)
    await selectCurrentDollSet(db, catSet.id)
    expect((await readDollSets(db)).map((set) => [set.normal.name, set.current])).toEqual([
      ['クマ人形', false],
      ['ネコ人形', true],
    ])

    await selectCurrentDollSet(db, null)
    expect((await readDollSets(db)).every((set) => !set.current)).toBe(true)
  })

  it('無い組をいまの人形に選ぶと false を返し、いまの人形を変えない', async () => {
    const bearSet = await addCurrentSet(bears)

    expect(await selectCurrentDollSet(db, bearSet.id + 100)).toBe(false)
    expect((await readDollSets(db))[0]?.current).toBe(true)
  })

  it('組の名前と画像を書き換えても、いまの人形のままにする。無い組なら null', async () => {
    const bearSet = await addCurrentSet(bears)

    const updated = await updateDollSet(db, bearSet.id, { ...bears, normal: { name: 'ちびクマ人形', mediaId: 'image-small-bear' } }, LATER)

    expect(updated).toEqual({
      id: bearSet.id,
      normal: { name: 'ちびクマ人形', mediaId: 'image-small-bear' },
      super: bears.super,
      current: true,
      updatedAt: '2026-10-21T12:30:00.000Z',
    })
    expect(await updateDollSet(db, bearSet.id + 100, bears, LATER)).toBeNull()
  })

  it('台帳に記録のない組は消せ、記録のある組は消せない', async () => {
    const bearSet = await addCurrentSet(bears)
    const catSet = await insertDollSet(db, cats, NOW)
    await changeDolls(db, manual(HANAKO, 'normal', 1, 'manual-1'), NOW)

    expect(await deleteDollSet(db, catSet.id)).toBe('deleted')
    expect(await deleteDollSet(db, bearSet.id)).toBe('in-use')
    expect(await deleteDollSet(db, catSet.id)).toBe('not-found')
    expect((await readDollSets(db)).map((set) => set.id)).toEqual([bearSet.id])
  })
})

describe('changeDolls・readDollHoldings', () => {
  it('いまの人形に増減を記録し、所持数は組ごと・種類ごとの合計になる', async () => {
    const bearSet = await addCurrentSet(bears)

    await changeDolls(db, manual(HANAKO, 'normal', 2, 'manual-1'), NOW)
    await changeDolls(db, manual(HANAKO, 'super', 1, 'manual-2'), NOW)
    const result = await changeDolls(db, manual(HANAKO, 'normal', -1, 'manual-3'), NOW)

    // 返すのは増減したあとの、その人のいまの人形の所持数
    expect(result).toEqual({ status: 'applied', holding: { userId: HANAKO, setId: bearSet.id, normal: 1, super: 1 } })
    expect(await readDollHoldings(db)).toEqual([{ userId: HANAKO, setId: bearSet.id, normal: 1, super: 1 }])
  })

  it('いまの人形を選び直しても、前の組の所持数は残る（集めたものとして見える）', async () => {
    const bearSet = await addCurrentSet(bears)
    await changeDolls(db, manual(HANAKO, 'normal', 1, 'manual-1'), NOW)
    const catSet = await addCurrentSet(cats)
    await changeDolls(db, manual(HANAKO, 'super', 1, 'manual-2'), NOW)
    await changeDolls(db, manual(TARO, 'normal', 3, 'manual-3'), NOW)

    expect(await readDollHoldings(db)).toEqual(
      expect.arrayContaining([
        { userId: HANAKO, setId: bearSet.id, normal: 1, super: 0 },
        { userId: HANAKO, setId: catSet.id, normal: 0, super: 1 },
        { userId: TARO, setId: catSet.id, normal: 3, super: 0 },
      ]),
    )
    expect(await readDollHoldings(db)).toHaveLength(3)
  })

  it('すべて減らして0になった人の組は、所持数の一覧に出さない', async () => {
    await addCurrentSet(bears)
    await changeDolls(db, manual(HANAKO, 'normal', 1, 'manual-1'), NOW)
    await changeDolls(db, manual(HANAKO, 'normal', -1, 'manual-2'), NOW)

    expect(await readDollHoldings(db)).toEqual([])
  })

  it('所持数より多くは減らせず、記録もしない', async () => {
    const bearSet = await addCurrentSet(bears)
    await changeDolls(db, manual(HANAKO, 'normal', 1, 'manual-1'), NOW)

    expect(await rejectionOf(() => changeDolls(db, manual(HANAKO, 'normal', -2, 'manual-2'), NOW))).toBe('not-enough')
    // スーパー人形は持っていないので、ふつうの人形があっても減らせない
    expect(await rejectionOf(() => changeDolls(db, manual(HANAKO, 'super', -1, 'manual-3'), NOW))).toBe('not-enough')
    expect(await readDollHoldings(db)).toEqual([{ userId: HANAKO, setId: bearSet.id, normal: 1, super: 0 }])
  })

  it('いまの人形が選ばれていなければ、増やすことも減らすこともできない', async () => {
    await insertDollSet(db, bears, NOW)

    expect(await rejectionOf(() => changeDolls(db, manual(HANAKO, 'normal', 1, 'manual-1'), NOW))).toBe('no-current-set')
    expect(await readDollHoldings(db)).toEqual([])
  })

  it('前の組の人形は、いまの人形を選び直したあとは減らせない', async () => {
    const bearSet = await addCurrentSet(bears)
    await changeDolls(db, manual(HANAKO, 'normal', 1, 'manual-1'), NOW)
    await addCurrentSet(cats)

    // 減らす先はいまの人形（ネコ）なので、クマを1つ持っていても足りない
    expect(await rejectionOf(() => changeDolls(db, manual(HANAKO, 'normal', -1, 'manual-2'), NOW))).toBe('not-enough')
    expect(await readDollHoldings(db)).toEqual([{ userId: HANAKO, setId: bearSet.id, normal: 1, super: 0 }])
  })

  it('同じきっかけの ID の増減は2度記録せず、再送だったことを返す', async () => {
    const bearSet = await addCurrentSet(bears)
    await changeDolls(db, manual(HANAKO, 'normal', 1, 'redemption-abc'), NOW)

    expect(await changeDolls(db, manual(HANAKO, 'normal', 1, 'redemption-abc'), NOW)).toEqual({ status: 'duplicate' })
    expect(await readDollHoldings(db)).toEqual([{ userId: HANAKO, setId: bearSet.id, normal: 1, super: 0 }])
  })

  it('配信中なら配信の ID を、配信外なら NULL を控える', async () => {
    await addCurrentSet(bears)
    await changeDolls(db, manual(HANAKO, 'normal', 1, 'manual-1'), NOW)
    db.sqlite
      .prepare("INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES ('stream-1', ?, NULL, 'もくもく作業', 'Software and Game Development')")
      .run('2026-10-21T12:10:00.000Z')
    await changeDolls(db, manual(HANAKO, 'normal', 1, 'manual-2'), LATER)

    const rows = db.sqlite.prepare('SELECT source_id, session_id FROM doll_ledger ORDER BY id').all()
    expect(rows).toEqual([
      { source_id: 'manual-1', session_id: null },
      { source_id: 'manual-2', session_id: 'stream-1' },
    ])
  })
})

describe('changeDolls の理由', () => {
  it('手での増減は理由を manual にし、トリガーの項目を持たない。トリガーで渡した増減は理由を trigger にし、項目を控える', async () => {
    // 前提: いまの人形が選ばれている
    await addCurrentSet(bears)

    await changeDolls(db, manual(HANAKO, 'normal', 1, 'manual-1'), NOW)
    await changeDolls(
      db,
      { userId: TARO, kind: 'super', delta: 1, reason: 'trigger', triggerKind: 'reward', sourceId: 'trigger:通知ID-1:dollGrant:0' },
      NOW,
    )

    // 検証: 台帳の行に、何で増えたかと、どのトリガーの項目で渡したかが残る
    const rows = db.sqlite.prepare('SELECT user_id, reason, trigger_kind FROM doll_ledger ORDER BY id').all()
    expect(rows).toEqual([
      { user_id: HANAKO, reason: 'manual', trigger_kind: null },
      { user_id: TARO, reason: 'trigger', trigger_kind: 'reward' },
    ])
  })
})

describe('deleteDollsOf', () => {
  it('その人の台帳だけを消す', async () => {
    const bearSet = await addCurrentSet(bears)
    await changeDolls(db, manual(HANAKO, 'normal', 1, 'manual-1'), NOW)
    await changeDolls(db, manual(TARO, 'super', 1, 'manual-2'), NOW)

    await deleteDollsOf(db, HANAKO)

    expect(await readDollHoldings(db)).toEqual([{ userId: TARO, setId: bearSet.id, normal: 0, super: 1 }])
  })
})
