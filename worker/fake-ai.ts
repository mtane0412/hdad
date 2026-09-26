/**
 * テスト用のLLMの代役
 *
 * Worker のテストだけが使う（プロダクションコードからは参照しない）。2種類あるのは、LLMの呼び先を決める層
 * （worker/llm.ts）を挟んでいるためである。
 * - createFakeWorkersAi: Cloudflare の Workers AI のバインディング（Env.AI）の代役。Env を組み立てる経路のテストが使う
 *   （呼び先の決定と用途からモデル名への読み替えも通るので、既定の設定（Workers AI）で動くことまで確かめられる）
 * - createFakeAi: 用途を指名して呼ぶ側（worker/llm.ts の TextGenerator）の代役。材料を組み立てる関数のテストが使う
 *
 * どちらも渡された引数を控えるので、用途の指名が正しいか、材料が漏れていないかも確かめられる。
 */
import type { LlmPurpose } from './llm-config'
import type { LlmRequest, TextGenerator, WorkersAi } from './llm'

interface 代役の条件 {
  /** 返す文面。省略すると当たり障りのない1文を返す */
  response?: string
  /** true なら呼ばれたときに失敗する（無料枠や残高を使い切った場合などの再現） */
  失敗する?: boolean
}

/** 既定の文面。文面そのものを問わないテストでも、読んで意味が分かるものにする */
const 既定の文面 = 'こんばんは！来てくれてありがとうございます'

/** 呼び出しの記録を添えた、Workers AI のバインディングの代役を作る */
export const createFakeWorkersAi = ({ response = 既定の文面, 失敗する = false }: 代役の条件 = {}): WorkersAi & {
  呼び出し: { model: string; input: Record<string, unknown> }[]
} => {
  const 呼び出し: { model: string; input: Record<string, unknown> }[] = []
  return {
    呼び出し,
    run: (model, input) => {
      呼び出し.push({ model, input })
      if (失敗する) return Promise.reject(new Error('Workers AI の無料枠を使い切りました'))
      return Promise.resolve({ response })
    },
  }
}

/** 呼び出しの記録を添えた、用途を指名して呼ぶ側の代役を作る */
export const createFakeAi = ({ response = 既定の文面, 失敗する = false }: 代役の条件 = {}): TextGenerator & {
  呼び出し: { purpose: LlmPurpose; request: LlmRequest }[]
} => {
  const 呼び出し: { purpose: LlmPurpose; request: LlmRequest }[] = []
  return {
    呼び出し,
    run: (purpose, request) => {
      呼び出し.push({ purpose, request })
      if (失敗する) return Promise.reject(new Error('LLMの無料枠を使い切りました'))
      return Promise.resolve(response)
    },
  }
}
