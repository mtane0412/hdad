/**
 * デモ用のサンプル（?demo=true）
 *
 * ふだんの意見ボードは、配信者がテーマを出しているあいだに視聴者のコメントから育っていくので、テーマを出していないと何も映らない。
 * それでは OBS での配置や見栄えを決められないため、管理画面のプレビューでは Worker に接続せず、意見が増えていき、論点が6つの枠を
 * 埋めるまでの場面を順に流す（作業机の src/task-desk/demo.ts と同じ考え方）。
 *
 * 注意: 意見の文言は上限（40文字）ちょうどのものを1件入れ、折り返したときの高さを確かめられるようにする。
 * 札の種類は4つとも出す（色と文字の見分けを確かめられるようにする）。
 * 注意: 問いかけ（issue #307）は、最初の意見が出るまでは無く、そのあと切り替わっていく。最後は上限（40文字）ちょうどのものにする。
 */
import type { OpinionBoard, OverlayOpinion, OverlayTopic } from './entry'

const theme = { id: 1, title: '配信中にAIをどこまで使っていい？', openedAt: '2026-10-10T12:00:00.000Z', closedAt: null }

/** 最初の意見が出たあとの問いかけ */
const FIRST_PROMPT = 'AIの使用料、配信者はどこまで払っていいと思う？'

/** 問いかけに答える意見が出たあとの問いかけ（上限の40文字ちょうど） */
const LONGEST_PROMPT = 'AIに手伝ってもらった配信、視聴者にはどこまで知らせてほしいと思う？それはなぜ？'

/** 何件目の意見まで届いたときに、最初の問いかけから切り替えるか */
const PROMPT_SWITCH_COUNT = 5

/** 時刻 minute 分に作った意見 */
const opinion = (id: number, kind: OverlayOpinion['kind'], text: string, author: string, minute: number): OverlayOpinion => ({
  id,
  kind,
  text,
  author,
  createdAt: `2026-10-10T12:${String(minute).padStart(2, '0')}:00.000Z`,
})

/** 届く順の意見と、入る論点 */
const arrivals: readonly { readonly topic: string; readonly opinion: OverlayOpinion }[] = [
  { topic: '視聴者との距離', opinion: opinion(1, 'issue', 'AIが返事すると、人と話している感じが薄れる', 'aoi', 1) },
  { topic: '作業のテンポ', opinion: opinion(2, 'solution', '調べ物はAIに任せて、配信の流れを止めない', 'riku', 2) },
  { topic: '間違いとの付き合い方', opinion: opinion(3, 'question', 'AIのまとめが間違っていたら、誰が直すのか', 'tsukimi_dev', 3) },
  { topic: '視聴者との距離', opinion: opinion(4, 'insight', '初見さんへの挨拶はAIでも嬉しかった', 'mugi', 4) },
  { topic: '間違いとの付き合い方', opinion: opinion(5, 'solution', '配信者が最後に目を通してから出すなら、AIがまとめた文を画面に出してもよいと思う', 'kei_kei', 5) },
  { topic: 'AIだと分かること', opinion: opinion(6, 'solution', 'AIが書いた文には印を付ける', 'hana', 6) },
  { topic: '見ていて楽しいか', opinion: opinion(7, 'insight', 'AIとの掛け合いが、それ自体コンテンツになっている', 'yuzu', 7) },
  { topic: '学びになるか', opinion: opinion(8, 'question', 'AIに任せた部分は、見ている側も学べるのか', 'sena', 8) },
]

/** 最初の count 件が届いたときの意見ボード（論点は最初に意見が入った順、論点の中は新しい順） */
const boardAfter = (count: number): OpinionBoard => {
  const topics: { title: string; opinions: OverlayOpinion[] }[] = []
  for (const arrival of arrivals.slice(0, count)) {
    const topic = topics.find(({ title }) => title === arrival.topic)
    if (topic === undefined) topics.push({ title: arrival.topic, opinions: [arrival.opinion] })
    else topic.opinions.unshift(arrival.opinion)
  }
  const prompt = count <= 1 ? null : count < PROMPT_SWITCH_COUNT ? FIRST_PROMPT : LONGEST_PROMPT
  return { theme: { ...theme, prompt }, topics: topics.map((topic, index): OverlayTopic => ({ id: index + 1, ...topic })) }
}

/** プレビューで順に流す場面。意見が届くたびに1場面 */
export const demoOpinionBoards: readonly OpinionBoard[] = arrivals.map((_, index) => boardAfter(index + 1))
