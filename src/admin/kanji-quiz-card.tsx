/**
 * 漢字クイズのカード（トリガーのページ）
 *
 * 漢字クイズ（issue #300）の演出で鳴らす音を場面ごとに選び、BGM と効果音の音量を決めて保存する。
 * 試し再生も置き、チャンネルポイントの交換を待たずに、選んだ級の問題を1問合成ページへ流させ、
 * 見栄えと置き場所と音を確かめられるようにする。級はトリガーの行の設定とは別に、このカードの中だけで選ぶ（保存はしない）。
 *
 * 鳴らす場面（枠）はコードで固定で（src/kanji-quiz/sound.ts の KANJI_QUIZ_SOUND_SLOTS）、ここでは枠ごとに
 * アップロード済みの音声を選ぶか「鳴らさない」にするだけにする（市町村紹介のカード town-tour-sound-card.tsx と同じ作り）。
 * 音声の追加はアップロードのページが受け持つ。設定は漢字クイズとして1つだけで、チャンネルポイントのトリガーと試し再生が共有する。
 *
 * 保存と試し再生の結果・失敗は、トリガーの保存と取り違えないよう、このカードの中に出す。
 *
 * 注意: 値の検証は Worker だけが持つ（.claude/rules/implementation.md）。ここでは返ってきた問題点を枠の名前に読み替えて並べる。
 */
import { useEffect, useId, useState } from 'react'
import { LoadFailure } from '@/components/load-failure'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { useUnsavedChanges } from '@/app/router'
import { ApiError } from '@/core/api'
import { isKankenGrade, type KankenGrade } from '@/kanji-quiz/grade'
import { KANJI_QUIZ_SOUND_SLOTS, type KanjiQuizSound, type KanjiQuizSoundSlot } from '@/kanji-quiz/sound'
import type { AdminApi, MediaItem } from './api'
import { DEFAULT_KANJI_QUIZ_GRADE, KANJI_QUIZ_GRADE_OPTIONS } from './form'
import { errorMessage, usePageActions } from './page-actions'
import { VolumeField } from './volume-field'

/** このカードが使う Worker の呼び出し */
export type KanjiQuizApi = Pick<AdminApi, 'kanjiQuizSound' | 'saveKanjiQuizSound' | 'playKanjiQuizDemo'>

/** 枠ごとの選択欄の名前。括弧の中はいつ鳴るか */
const SLOT_LABELS: Readonly<Record<KanjiQuizSoundSlot, string>> = {
  bgm: 'BGM（級が出てから、正解か時間切れまで流す）',
  start: '出題（級が出たとき）',
  countdown: 'カウントダウン（最後の5秒、1秒ごと）',
  correct: '正解（正解者が出たとき）',
  timeUp: '時間切れ',
}

/** 音量の項目の名前（Worker の問題点の読み替えにも使う） */
const VOLUME_LABELS = { bgmVolume: 'BGMの音量', effectVolume: '効果音の音量' } as const

/** 選択欄で「鳴らさない」を表す値（選択欄の値は文字列しか持てないので、null と空文字を行き来する） */
const SILENT = ''

type Loaded = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready' }

/**
 * Worker の問題点（`slots.correct: …`・`bgmVolume: …`）の先頭を、画面の項目の名前に読み替える。
 * 知らない形の問題点は、そのまま出す（読み替えられないものを隠さない）
 */
const describeSoundProblem = (problem: string): string => {
  const [field = '', ...rest] = problem.split(': ')
  const message = rest.join(': ')
  const slot = KANJI_QUIZ_SOUND_SLOTS.find((candidate) => field === `slots.${candidate}`)
  if (slot !== undefined) return `${SLOT_LABELS[slot]}: ${message}`
  if (field === 'bgmVolume' || field === 'effectVolume') return `${VOLUME_LABELS[field]}: ${message}`
  return problem
}

const failureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['漢字クイズの音の設定に問題があります。直してから保存し直してください', ...error.problems.map((problem) => `・${describeSoundProblem(problem)}`)]
    : [errorMessage(error)]

interface KanjiQuizCardProps {
  api: KanjiQuizApi
  /** アップロード済みの素材（トリガーのページが読んだもの）。音声だけを選択肢にする */
  media: readonly MediaItem[]
}

export const KanjiQuizCard = ({ api, media }: KanjiQuizCardProps) => {
  const id = useId()
  const actions = usePageActions(failureLines)
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [draft, setDraft] = useState<KanjiQuizSound | null>(null)
  // 最後に保存した（または読み込んだ）設定。今の入力と食い違えば、未保存の変更があると知らせる
  const [saved, setSaved] = useState<KanjiQuizSound | null>(null)
  /** 試し再生で出題する級。保存はしない */
  const [grade, setGrade] = useState<KankenGrade>(DEFAULT_KANJI_QUIZ_GRADE)

  useEffect(() => {
    let cancelled = false
    api.kanjiQuizSound().then(
      (sound) => {
        if (cancelled) return
        setDraft(sound)
        setSaved(sound)
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

  const audios = media.filter((item) => item.kind === 'audio')

  const save = async (sound: KanjiQuizSound): Promise<string> => {
    const result = await api.saveKanjiQuizSound(sound)
    setSaved(result)
    // 保存を待つ間に入力が書き換えられていたら、その内容を応答で上書きしない（書き換えた分は次の保存で送られる）
    setDraft((current) => (current === sound ? result : current))
    return '漢字クイズの音を保存しました'
  }

  const playDemo = async (): Promise<string> =>
    `${await api.playKanjiQuizDemo(grade)} を出題しました。オーバーレイに「漢字クイズ」の素材を置いていれば流れます`

  const soundFields = (() => {
    if (loaded.status === 'loading' || draft === null) {
      if (loaded.status === 'failed') return <LoadFailure title="漢字クイズの音を表示できません" message={loaded.message} />
      return <Skeleton className="h-40 w-full" aria-label="漢字クイズの音を読み込んでいます" />
    }
    const updateSlot = (slot: KanjiQuizSoundSlot, value: string): void =>
      setDraft({ ...draft, slots: { ...draft.slots, [slot]: value === SILENT ? null : value } })
    return (
      <>
        <div className="grid gap-4 sm:grid-cols-2">
          {KANJI_QUIZ_SOUND_SLOTS.map((slot) => {
            const selected = draft.slots[slot]
            // 一覧に無い素材が選ばれていれば、別の音に見せずにそのまま出す（素材は使われているあいだ消せないので、ふつうは起きない）
            const missing = selected !== null && !audios.some((item) => item.id === selected)
            return (
              <div key={slot} className="flex flex-col gap-2">
                <Label htmlFor={`${id}-${slot}`}>{SLOT_LABELS[slot]}</Label>
                <NativeSelect id={`${id}-${slot}`} className="w-full" value={selected ?? SILENT} onChange={(event) => updateSlot(slot, event.currentTarget.value)}>
                  <NativeSelectOption value={SILENT}>鳴らさない</NativeSelectOption>
                  {missing && <NativeSelectOption value={selected}>見つからない素材（{selected}）</NativeSelectOption>}
                  {audios.map((item) => (
                    <NativeSelectOption key={item.id} value={item.id}>
                      {item.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            )
          })}
          <VolumeField id={`${id}-bgm-volume`} label={VOLUME_LABELS.bgmVolume} volume={draft.bgmVolume} onChange={(bgmVolume) => setDraft({ ...draft, bgmVolume })} />
          <VolumeField
            id={`${id}-effect-volume`}
            label={VOLUME_LABELS.effectVolume}
            volume={draft.effectVolume}
            onChange={(effectVolume) => setDraft({ ...draft, effectVolume })}
          />
        </div>
        <div className="flex items-center gap-3">
          <Button type="button" disabled={actions.busy} onClick={() => void actions.run(() => save(draft))}>
            音を保存
          </Button>
          {unsaved && <span className="text-sm text-muted-foreground">未保存の変更があります</span>}
        </div>
      </>
    )
  })()

  return (
    <Card>
      <CardHeader>
        <CardTitle>漢字クイズ</CardTitle>
        <CardDescription>
          チャンネルポイントが交換されたら、熟語の読みを問う漢字クイズを流す。問題はリポジトリの問題集から、トリガーで決めた級ごとの重みに沿って1問選ぶ。
          制限時間が過ぎると正解の読みと解説を出す。場面ごとに鳴らす音を選べる（BGM を流しているあいだ配信の BGM は下がる）。音声はアップロードのページで追加する。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {actions.feedback}
        {soundFields}
        <p className="text-sm text-muted-foreground">交換を待たずに試しに流せる。音は保存したものが鳴るので、未保存の変更があるあいだは押せない。</p>
        <div className="flex flex-col gap-2 sm:max-w-xs">
          <Label htmlFor={`${id}-grade`}>試しに出題する級</Label>
          <NativeSelect
            id={`${id}-grade`}
            className="w-full"
            value={grade}
            onChange={(event) => {
              const { value } = event.currentTarget
              // 選択肢は級の一覧から作っているので、級でない値は来ない
              if (isKankenGrade(value)) setGrade(value)
            }}
          >
            {KANJI_QUIZ_GRADE_OPTIONS.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        {/* 試し再生は保存済みの音で鳴る。選び直した音を保存せずに流すと、聞き比べたつもりのものと食い違うので押させない */}
        <Button type="button" variant="outline" className="self-start" disabled={actions.busy || unsaved} onClick={() => void actions.run(playDemo)}>
          漢字クイズを試しに流す
        </Button>
      </CardContent>
    </Card>
  )
}
