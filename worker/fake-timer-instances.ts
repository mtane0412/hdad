/**
 * テスト用の、本物の AdBreakTimer を名前ごとに動かす Durable Object の束
 *
 * 広告の終了の予約だけを確かめるテストは worker/fake-ad-break-timer.ts で足りるが、ポモドーロのタイマーは
 * Durable Object の中に状態とアラームを持つので、本物の AdBreakTimer に storage とアラームの代役を渡して動かす。
 * 名前（idFromName に渡すもの）ごとにインスタンスを1つ作り、仕掛けられているアラームの時刻を名前ごとに確かめられるようにする。
 * Worker のテストだけが使う（プロダクションコードからは参照しない）。
 */
import { AdBreakTimer, type AdBreakDependencies, type AdBreakTimerNamespace, type AdBreakTimerState } from './ad-break-timer'
import type { Env } from './http'

/**
 * @param envOf インスタンスに渡す環境。環境がこの束を AD_BREAKS として持つので、作ったあとで読めるよう関数で受け取る
 * @param dependencies インスタンスに渡す依存（Twitch の代役・時計）
 * @param setNow アラームを鳴らすときに、時計をその時刻へ進める
 */
export const createTimerInstances = (envOf: () => Env, dependencies: AdBreakDependencies, setNow: (at: number) => void) => {
  const instances = new Map<string, AdBreakTimer>()
  /** 名前ごとの、仕掛けられているアラームの時刻。外されたら null */
  const alarms = new Map<string, number | null>()

  const stateOf = (name: string): AdBreakTimerState => {
    const values = new Map<string, unknown>()
    return {
      storage: {
        get: async <T>(key: string): Promise<T | undefined> => values.get(key) as T | undefined,
        // 本物の storage と同じく、保存したあとで元の値を書き換えても中身が変わらないよう写しを持つ
        put: async (key: string, value: unknown): Promise<void> => void values.set(key, structuredClone(value)),
        delete: async (key: string): Promise<boolean> => values.delete(key),
        setAlarm: async (scheduledTime: number): Promise<void> => void alarms.set(name, scheduledTime),
        deleteAlarm: async (): Promise<void> => void alarms.set(name, null),
      },
    }
  }

  const instanceOf = (name: string): AdBreakTimer => {
    const existing = instances.get(name)
    if (existing) return existing
    const created = new AdBreakTimer(stateOf(name), envOf(), dependencies)
    instances.set(name, created)
    return created
  }

  const namespace: AdBreakTimerNamespace = {
    idFromName: (name) => ({ toString: () => name, equals: (other) => other.toString() === name, name }),
    get: (id) => instanceOf(id.toString()),
  }

  return {
    namespace,
    /** その名前のインスタンスに仕掛けられているアラームの時刻。無ければ null */
    alarmOf: (name: string): number | null => alarms.get(name) ?? null,
    /** アラームが鳴ったものとして、その時刻へ時計を進めてから alarm() を呼ぶ */
    ring: async (name: string): Promise<void> => {
      const at = alarms.get(name)
      if (at === undefined || at === null) throw new Error(`${name} のアラームは仕掛けられていません`)
      setNow(at)
      alarms.set(name, null)
      await instanceOf(name).alarm()
    },
  }
}
