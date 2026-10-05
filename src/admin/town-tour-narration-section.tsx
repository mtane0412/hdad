/**
 * 市町村紹介のカードの、ナレーションの区画（issue #255）
 *
 * 市町村紹介の冒頭の一文・大見出し・各項目・配信者への振りを VOICEVOX のナレーターの声で読み上げるかと、
 * 読み上げの話者ID・速度を選んで保存する。合成はさくらのAI Engine で行う（従量課金。APIキーは Worker のシークレット）。
 * チャットの読み上げ（コネクターのページの VOICEVOX）とは別の設定で、別の声にできる。
 *
 * 音の設定とは保存先も保存のボタンも分ける（Worker の経路が別で、片方の失敗でもう片方を保存し損ねないため）。
 * 保存の結果・失敗はこの区画の中に出す。未保存の変更があるかは親（市町村紹介のカード）にも伝え、試し再生を止めさせる
 * （試し再生は保存済みの声で読み上げるため）。
 *
 * 注意: 値の検証は Worker だけが持つ（.claude/rules/implementation.md）。数の欄は文字のまま持ち、空欄を 0 に丸めず NaN のまま送る。
 */
import { useEffect, useId, useState } from 'react'
import { LoadFailure } from '@/components/load-failure'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { useUnsavedChanges } from '@/app/router'
import { ApiError } from '@/core/api'
import { numberOf } from '@/speech/form'
import type { TownTourNarration } from '@/town-tour/narration'
import type { AdminApi } from './api'
import { errorMessage, usePageActions } from './page-actions'

/** この区画が使う Worker の呼び出し */
export type TownTourNarrationApi = Pick<AdminApi, 'townTourNarration' | 'saveTownTourNarration'>

/** 入力欄の名前（Worker の問題点の読み替えにも使う） */
const FIELD_LABELS = { enabled: 'ナレーションで読み上げる', speaker: 'ナレーションの話者ID', speed: 'ナレーションの読み上げ速度' } as const

/** 入力欄が持つ値。数の欄は文字のまま持ち、保存のときに数へ直す（空欄を 0 に丸めないため） */
interface NarrationForm {
  enabled: boolean
  speaker: string
  speed: string
}

type Loaded = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready' }

const toForm = ({ enabled, speaker, speed }: TownTourNarration): NarrationForm => ({ enabled, speaker: String(speaker), speed: String(speed) })

const toNarration = ({ enabled, speaker, speed }: NarrationForm): TownTourNarration => ({ enabled, speaker: numberOf(speaker), speed: numberOf(speed) })

/**
 * Worker の問題点（`speed: …`）の先頭を、画面の入力欄の名前に読み替える。
 * 知らない形の問題点は、そのまま出す（読み替えられないものを隠さない）
 */
const describeNarrationProblem = (problem: string): string => {
  const [field = '', ...rest] = problem.split(': ')
  const isField = (name: string): name is keyof typeof FIELD_LABELS => name in FIELD_LABELS
  return isField(field) ? `${FIELD_LABELS[field]}: ${rest.join(': ')}` : problem
}

const failureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['市町村紹介のナレーションの設定に問題があります。直してから保存し直してください', ...error.problems.map((problem) => `・${describeNarrationProblem(problem)}`)]
    : [errorMessage(error)]

interface TownTourNarrationSectionProps {
  api: TownTourNarrationApi
  /** 未保存の変更があるかが変わったときに呼ぶ（親が試し再生を止めるため） */
  onUnsavedChange(unsaved: boolean): void
}

export const TownTourNarrationSection = ({ api, onUnsavedChange }: TownTourNarrationSectionProps) => {
  const id = useId()
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [draft, setDraft] = useState<NarrationForm | null>(null)
  // 最後に保存した（または読み込んだ）設定。今の入力と食い違えば、未保存の変更があると知らせる
  const [saved, setSaved] = useState<NarrationForm | null>(null)
  const actions = usePageActions(failureLines)

  useEffect(() => {
    let cancelled = false
    api.townTourNarration().then(
      (narration) => {
        if (cancelled) return
        setDraft(toForm(narration))
        setSaved(toForm(narration))
        setLoaded({ status: 'ready' })
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  const unsaved = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved)
  useUnsavedChanges(unsaved)
  useEffect(() => onUnsavedChange(unsaved), [unsaved, onUnsavedChange])

  const save = async (form: NarrationForm): Promise<string> => {
    const result = toForm(await api.saveTownTourNarration(toNarration(form)))
    setSaved(result)
    // 保存を待つ間に入力が書き換えられていたら、その内容を応答で上書きしない（書き換えた分は次の保存で送られる）
    setDraft((current) => (current === form ? result : current))
    return '市町村紹介のナレーションを保存しました'
  }

  if (loaded.status === 'failed') return <LoadFailure title="市町村紹介のナレーションを表示できません" message={loaded.message} />
  if (draft === null) return <Skeleton className="h-24 w-full" aria-label="市町村紹介のナレーションを読み込んでいます" />

  return (
    <section className="flex flex-col gap-4" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="text-sm font-medium">
        ナレーション
      </h3>
      {actions.feedback}
      <div className="flex items-center gap-2">
        <Checkbox id={`${id}-enabled`} checked={draft.enabled} onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked === true })} />
        <Label htmlFor={`${id}-enabled`}>{FIELD_LABELS.enabled}</Label>
      </div>
      <p className="text-sm text-muted-foreground">
        冒頭の一文・大見出し・各項目・配信者への振りを、さくらのAI Engine の VOICEVOX で読み上げる。場面は読み上げの長さに合わせて延びる。従量課金で、1件あたり最大でおよそ500モーラ（約0.15円）。WorkerのシークレットSAKURA_AI_API_KEYが要る。
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-speaker`}>{FIELD_LABELS.speaker}</Label>
          <Input
            id={`${id}-speaker`}
            type="number"
            min={0}
            step={1}
            value={draft.speaker}
            onChange={(event) => setDraft({ ...draft, speaker: event.currentTarget.value })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-speed`}>{FIELD_LABELS.speed}</Label>
          <Input
            id={`${id}-speed`}
            type="number"
            min={0.5}
            max={2}
            step={0.1}
            value={draft.speed}
            onChange={(event) => setDraft({ ...draft, speed: event.currentTarget.value })}
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" disabled={actions.busy} onClick={() => void actions.run(() => save(draft))}>
          ナレーションを保存
        </Button>
        {unsaved && <span className="text-sm text-muted-foreground">未保存の変更があります</span>}
      </div>
    </section>
  )
}
