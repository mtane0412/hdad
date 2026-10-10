/**
 * 意見ボードのページ（/opinions/）の、コメントの内訳と意見にならなかったコメントの一覧（issue #308）
 *
 * 配信の混雑や振り分けの取りこぼしで意見にならなかったコメントを、配信者が1件ずつ救い出すための部品である。
 * - コメントの内訳: 受け取った・意見にした・振り分け待ち・規則で落とした（理由ごと）・Jev が落とした・LLM が無関係とした・失敗の数
 * - 意見にならなかったコメントの一覧（新しい順）。1件ずつ次のどちらかができる
 *   - 新しい意見にする: Worker に下書き（札の種類・1文・論点）を作らせ、配信者が直してから保存する
 *   - 既にある意見に統合する: 意見を選んで、そのもとのコメントに足す
 *
 * Worker の呼び出しと結果の表示はページ（opinion-page.tsx）が持ち、ここは入力と選択だけを持つ。値の検証は Worker だけが持つ。
 *
 * 注意: 書きかけ（下書きを開いた・統合先を選んでいる）のあいだは、ページを離れる前に確認を出す（useUnsavedChanges）。
 */
import { useId, useState } from 'react'
import { useUnsavedChanges } from '@/app/router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from '@/components/ui/native-select'
import { DROP_REASONS, type AdminTopic, type DropReason, type OpinionCommentCounts, type RescuableComment, type RescuedOpinion } from './api'
import { OPINION_KINDS, OPINION_KIND_LABELS, type OpinionKind } from './entry'

/** 規則で落とした理由の呼び名 */
const DROP_REASON_LABELS: Readonly<Record<DropReason, string>> = {
  command: 'コマンド',
  emote: 'エモートだけ',
  reaction: '短い反応',
}

/** 論点の選択欄で「新しい論点を作る」を表す値（既にある論点はIDの文字列） */
const NEW_TOPIC = 'new'

/** コメントがなぜ意見にならなかったかの呼び名 */
const statusLabel = (comment: RescuableComment): string => {
  switch (comment.status) {
    case 'dropped':
      return comment.dropReason === null ? '規則で落とした' : `規則で落とした（${DROP_REASON_LABELS[comment.dropReason]}）`
    case 'filtered':
      return 'Jev が意見ではないとみた'
    case 'ignored':
      return 'LLM が無関係とした'
    case 'failed':
      return '振り分けに失敗'
    case 'pending':
      return '振り分ける前に締め切った'
  }
}

/** コメントの内訳 */
export const CommentCounts = ({ counts }: { counts: OpinionCommentCounts }) => {
  const dropped = counts.dropped.command + counts.dropped.emote + counts.dropped.reaction
  const droppedDetail = DROP_REASONS.map((reason) => `${DROP_REASON_LABELS[reason]} ${counts.dropped[reason]}`).join('・')
  const lines = [
    `受け取った: ${counts.received}件`,
    `意見にした: ${counts.used}件`,
    `振り分け待ち: ${counts.pending}件`,
    `規則で落とした: ${dropped}件（${droppedDetail}）`,
    `Jev が意見ではないとみた: ${counts.filtered}件`,
    `LLM が無関係とした: ${counts.ignored}件`,
    `振り分けに失敗: ${counts.failed}件`,
  ]
  return (
    <ul role="group" aria-label="コメントの内訳" className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  )
}

/** 新しい意見にするときの、書きかけの中身 */
interface OpinionDraftForm {
  readonly type: 'new'
  readonly kind: OpinionKind
  readonly text: string
  /** 選んだ論点（既にある論点はIDの文字列、新しい論点は NEW_TOPIC） */
  readonly topic: string
  readonly newTitle: string
}

/** 既にある意見に統合するときの、選んでいる意見 */
interface JoinForm {
  readonly type: 'join'
  readonly opinionId: string
}

/** 下書きを、書きかけの中身にする */
const toForm = (draft: RescuedOpinion): OpinionDraftForm => ({
  type: 'new',
  kind: draft.kind,
  text: draft.text,
  topic: draft.topic.type === 'existing' ? String(draft.topic.id) : NEW_TOPIC,
  newTitle: draft.topic.type === 'new' ? draft.topic.title : '',
})

/** 書きかけの中身を、保存する意見にする */
const toOpinion = (form: OpinionDraftForm): RescuedOpinion => ({
  kind: form.kind,
  text: form.text,
  topic: form.topic === NEW_TOPIC ? { type: 'new', title: form.newTitle } : { type: 'existing', id: Number(form.topic) },
})

/** 意見にならなかったコメントを扱うページの操作 */
export interface RescueActions {
  readonly busy: boolean
  /** 下書きを作らせる。作れなければ undefined（理由はページが出す） */
  draft(commentId: number): Promise<RescuedOpinion | undefined>
  /** 新しい意見にする。保存できたか */
  rescue(commentId: number, opinion: RescuedOpinion): Promise<boolean>
  /** 既にある意見に統合する。保存できたか */
  join(commentId: number, opinionId: number): Promise<boolean>
}

/** 意見にならなかったコメント1件 */
const RescueItem = ({ comment, topics, actions }: { comment: RescuableComment; topics: readonly AdminTopic[]; actions: RescueActions }) => {
  const [form, setForm] = useState<OpinionDraftForm | JoinForm | null>(null)
  useUnsavedChanges(form !== null)
  const ids = { kind: useId(), text: useId(), topic: useId(), newTitle: useId(), opinion: useId() }
  /** 統合先を選びはじめるときに選んでおく意見。意見が1件も無ければ統合できない */
  const firstOpinion = topics.flatMap((topic) => topic.opinions)[0]

  const startNew = async (): Promise<void> => {
    const draft = await actions.draft(comment.id)
    if (draft !== undefined) setForm(toForm(draft))
  }
  const save = async (): Promise<void> => {
    if (form === null) return
    const saved = form.type === 'new' ? await actions.rescue(comment.id, toOpinion(form)) : await actions.join(comment.id, Number(form.opinionId))
    if (saved) setForm(null)
  }

  return (
    <li role="group" aria-label={`コメント「${comment.text}」`} className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{statusLabel(comment)}</Badge>
        <span>{`${comment.userName}: ${comment.text}`}</span>
      </div>
      {comment.replyName !== null && <p className="text-sm text-muted-foreground">{`${comment.replyName}さんの「${comment.replyText ?? ''}」への返信`}</p>}

      {form === null && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={actions.busy} onClick={() => void startNew()}>
            新しい意見にする
          </Button>
          {firstOpinion !== undefined && (
            <Button type="button" size="sm" variant="outline" disabled={actions.busy} onClick={() => setForm({ type: 'join', opinionId: String(firstOpinion.id) })}>
              既にある意見に統合する
            </Button>
          )}
        </div>
      )}

      {form?.type === 'new' && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor={ids.kind}>札の種類</Label>
              <NativeSelect id={ids.kind} value={form.kind} onChange={(event) => setForm({ ...form, kind: OPINION_KINDS.find((kind) => kind === event.currentTarget.value) ?? form.kind })}>
                {OPINION_KINDS.map((kind) => (
                  <NativeSelectOption key={kind} value={kind}>
                    {OPINION_KIND_LABELS[kind]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={ids.topic}>入れる論点</Label>
              <NativeSelect id={ids.topic} value={form.topic} onChange={(event) => setForm({ ...form, topic: event.currentTarget.value })}>
                {topics.map((topic) => (
                  <NativeSelectOption key={topic.id} value={String(topic.id)}>
                    {topic.title}
                  </NativeSelectOption>
                ))}
                <NativeSelectOption value={NEW_TOPIC}>新しい論点を作る</NativeSelectOption>
              </NativeSelect>
            </div>
            {form.topic === NEW_TOPIC && (
              <div className="flex flex-col gap-1">
                <Label htmlFor={ids.newTitle}>新しい論点の名前</Label>
                <Input id={ids.newTitle} value={form.newTitle} onChange={(event) => setForm({ ...form, newTitle: event.currentTarget.value })} />
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={ids.text}>意見</Label>
            <Input id={ids.text} value={form.text} onChange={(event) => setForm({ ...form, text: event.currentTarget.value })} />
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={actions.busy} onClick={() => void save()}>
              意見にする
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={actions.busy} onClick={() => setForm(null)}>
              やめる
            </Button>
          </div>
        </div>
      )}

      {form?.type === 'join' && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor={ids.opinion}>統合する意見</Label>
            <NativeSelect id={ids.opinion} value={form.opinionId} onChange={(event) => setForm({ type: 'join', opinionId: event.currentTarget.value })}>
              {topics.map((topic) => (
                <NativeSelectOptGroup key={topic.id} label={topic.title}>
                  {topic.opinions.map((opinion) => (
                    <NativeSelectOption key={opinion.id} value={String(opinion.id)}>
                      {/* 隠した意見に統合しても配信画面には出ないので、それと分かるようにする */}
                      {opinion.hidden ? `${opinion.text}（隠しています）` : opinion.text}
                    </NativeSelectOption>
                  ))}
                </NativeSelectOptGroup>
              ))}
            </NativeSelect>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={actions.busy} onClick={() => void save()}>
              統合する
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={actions.busy} onClick={() => setForm(null)}>
              やめる
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}

/** 意見にならなかったコメントの一覧（新しい順） */
export const RescueList = ({ comments, topics, actions }: { comments: readonly RescuableComment[]; topics: readonly AdminTopic[]; actions: RescueActions }) =>
  comments.length === 0 ? (
    <p className="text-sm text-muted-foreground">意見にならなかったコメントはありません。</p>
  ) : (
    <ul className="flex flex-col gap-2">
      {comments.map((comment) => (
        <RescueItem key={comment.id} comment={comment} topics={topics} actions={actions} />
      ))}
    </ul>
  )
