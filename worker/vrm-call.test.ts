/**
 * VRMのマスコットの反応の呼び出しの組み立て（vrm-call.ts）のテスト
 *
 * Worker は動き方の種と反応の種類と、出す VRM のURLだけを押し出す。動きの中身は合成ページが種と反応の種類から計算する。
 * 種は 0 以上 2^32 未満の整数で、合成ページの読み取り（src/vrm/call.ts の parseVrmCall）がそのまま受け取れる形にする。
 * 反応の種類はトリガーの項目ごとに決め切る（配信者が選ぶ欄を持たない）。
 */
import { describe, expect, it } from 'vitest'
import { VRM_REACTIONS as STAGE_VRM_REACTIONS, parseVrmCall } from '../src/vrm/call'
import { TRIGGER_KINDS } from './trigger-menu'
import { VRM_REACTIONS, vrmCallOf, vrmDemoReactionOf, vrmReactionOf, vrmSeedOf } from './vrm-call'

/** 看板娘の VRM（Worker がオーバーレイ用キーつきのURLに置き換えたもの） */
const model = '/api/media/media-kanban?key=issued-overlay-key-0123456789abcdefghij'

describe('vrmCallOf', () => {
  it('VRM のURLを、種と反応の種類と一緒に並べる', () => {
    expect(vrmCallOf(model, 42, 'thanks', '呼び出しID')).toEqual({ id: '呼び出しID', seed: 42, reaction: 'thanks', model })
  })

  it('合成ページの読み取りが、そのまま同じ呼び出しとして読める', () => {
    for (const reaction of VRM_REACTIONS) {
      const call = vrmCallOf(model, 4294967295, reaction, '呼び出しID')
      expect(parseVrmCall(JSON.stringify(call))).toEqual(call)
    }
  })

  it('反応の種類の一覧は、合成ページと同じ', () => {
    expect([...VRM_REACTIONS]).toEqual([...STAGE_VRM_REACTIONS])
  })
})

describe('vrmReactionOf', () => {
  it('フォロー・サブスク・チャンネルポイントにはお礼をする', () => {
    for (const kind of ['follow', 'subscribe', 'resubscribe', 'reward'] as const) expect(vrmReactionOf(kind)).toBe('thanks')
  })

  it('レイドとPRのマージには大喜びする', () => {
    expect(vrmReactionOf('raid')).toBe('cheer')
    expect(vrmReactionOf('pullRequestMerged')).toBe('cheer')
  })

  it('来た人への挨拶・休憩の始まり・広告の終わりには手を振る', () => {
    for (const kind of ['newViewer', 'comeback', 'welcome', 'fromUserFirstOfStream', 'pomodoroBreakBegin', 'adBreakEnd'] as const) {
      expect(vrmReactionOf(kind)).toBe('wave')
    }
  })

  it('ふだんの発言・コミット・作業の始まり・広告の始まりにはうなずく', () => {
    for (const kind of ['everyMessage', 'keyword', 'fromUser', 'commitPushed', 'pomodoroWorkBegin', 'adBreakBegin'] as const) {
      expect(vrmReactionOf(kind)).toBe('nod')
    }
  })

  it('どの項目にも反応が決まっている', () => {
    for (const kind of TRIGGER_KINDS) expect(VRM_REACTIONS).toContain(vrmReactionOf(kind))
  })
})

describe('vrmDemoReactionOf', () => {
  it('試し再生では、種からどの反応も選ばれうる', () => {
    const reactions = new Set(Array.from({ length: 40 }, (_, seed) => vrmDemoReactionOf(seed)))

    expect(reactions).toEqual(new Set(VRM_REACTIONS))
  })
})

describe('vrmSeedOf', () => {
  it('乱数の32ビットの値をそのまま種にする', () => {
    expect(vrmSeedOf(new Uint32Array([358]))).toBe(358)
  })

  it('値が入っていなければ投げる', () => {
    expect(() => vrmSeedOf(new Uint32Array(0))).toThrow(/種にする乱数がありません/)
  })
})
