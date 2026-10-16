/**
 * チャットで推理の音のカード（/chat-deduction/ のページ）
 *
 * ゲームの場面ごとに鳴らす音を選び、BGM と効果音の音量を決めて保存する。鳴らすのは合成ページの素材「チャットで推理」。
 * 鳴らす場面（枠）はコードで固定で（src/chat-deduction/sound.ts の CHAT_DEDUCTION_SOUND_SLOTS）、ここでは枠ごとに
 * アップロード済みの音声を選ぶか「鳴らさない」にするだけにする（漢字クイズのカード src/admin/kanji-quiz-card.tsx と同じ作り）。
 * 音声の追加はアップロードのページが受け持つ。
 *
 * 保存の結果・失敗は、ゲームの操作と取り違えないよう、このカードの中に出す。
 *
 * 注意: 値の検証は Worker だけが持つ（.claude/rules/implementation.md）。ここでは返ってきた問題点を枠の名前に読み替えて並べる。
 * 注意: 保存した音は、次にゲームが動いたとき（または合成ページが読み直したとき）から鳴る。開催中の合成ページへは押し出さない。
 */
import { useEffect, useId, useState } from 'react'
import type { MediaItem } from '@/admin/api'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { VolumeField } from '@/admin/volume-field'
import { useUnsavedChanges } from '@/app/router'
import { SaveBar } from '@/components/save-bar'
import { LoadFailure } from '@/components/load-failure'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiError } from '@/core/api'
import type { ChatDeductionApi } from './api'
import { CHAT_DEDUCTION_SOUND_SLOTS, type ChatDeductionSound, type ChatDeductionSoundSlot } from './sound'

/** このカードが使う Worker の呼び出し */
export type ChatDeductionSoundApi = Pick<ChatDeductionApi, 'sound' | 'saveSound'>

/** 枠ごとの選択欄の名前。括弧の中はいつ鳴るか */
const SLOT_LABELS: Readonly<Record<ChatDeductionSoundSlot, string>> = {
  bgm: 'BGM（ゲームを始めてから、正解か打ち切りまで流す）',
  start: '開始（ゲームを始めたとき）',
  answered: '回答（質問に答えたとき）',
  wrong: '不正解（解答が外れたとき）',
  correct: '正解（正解の解答が出たとき）',
  stopped: '打ち切り（ゲームを終えたとき）',
}

/** 音量の項目の名前（Worker の問題点の読み替えにも使う） */
const VOLUME_LABELS = { bgmVolume: 'BGMの音量', effectVolume: '効果音の音量' } as const

/** 選択欄で「鳴らさない」を表す値（選択欄の値は文字列しか持てないので、null と空文字を行き来する） */
const SILENT = ''

type Loaded = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready'; audios: readonly MediaItem[] }

/**
 * Worker の問題点（`slots.correct: …`・`bgmVolume: …`）の先頭を、画面の項目の名前に読み替える。
 * 知らない形の問題点は、そのまま出す（読み替えられないものを隠さない）
 */
const describeSoundProblem = (problem: string): string => {
  const [field = '', ...rest] = problem.split(': ')
  const message = rest.join(': ')
  const slot = CHAT_DEDUCTION_SOUND_SLOTS.find((candidate) => field === `slots.${candidate}`)
  if (slot !== undefined) return `${SLOT_LABELS[slot]}: ${message}`
  if (field === 'bgmVolume' || field === 'effectVolume') return `${VOLUME_LABELS[field]}: ${message}`
  return problem
}

const failureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['チャットで推理の音の設定に問題があります。直してから保存し直してください', ...error.problems.map((problem) => `・${describeSoundProblem(problem)}`)]
    : [errorMessage(error)]

interface ChatDeductionSoundCardProps {
  api: ChatDeductionSoundApi
  /** アップロード済みの素材を読む。音声だけを選択肢にする */
  loadMedia: () => Promise<MediaItem[]>
}

export const ChatDeductionSoundCard = ({ api, loadMedia }: ChatDeductionSoundCardProps) => {
  const id = useId()
  const actions = usePageActions(failureLines)
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [draft, setDraft] = useState<ChatDeductionSound | null>(null)
  // 最後に保存した（または読み込んだ）設定。今の入力と食い違えば、未保存の変更があると知らせる
  const [saved, setSaved] = useState<ChatDeductionSound | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([api.sound(), loadMedia()]).then(
      ([sound, media]) => {
        if (cancelled) return
        setDraft(sound)
        setSaved(sound)
        setLoaded({ status: 'ready', audios: media.filter((item) => item.kind === 'audio') })
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, loadMedia])

  const unsaved = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved)
  useUnsavedChanges(unsaved)

  const save = async (sound: ChatDeductionSound): Promise<string> => {
    const result = await api.saveSound(sound)
    setSaved(result)
    // 保存を待つ間に入力が書き換えられていたら、その内容を応答で上書きしない（書き換えた分は次の保存で送られる）
    setDraft((current) => (current === sound ? result : current))
    return 'チャットで推理の音を保存しました'
  }

  const soundFields = (() => {
    if (loaded.status === 'failed') return <LoadFailure title="チャットで推理の音を表示できません" message={loaded.message} />
    if (loaded.status === 'loading' || draft === null) return <Skeleton className="h-40 w-full" aria-label="チャットで推理の音を読み込んでいます" />
    const { audios } = loaded
    const updateSlot = (slot: ChatDeductionSoundSlot, value: string): void =>
      setDraft({ ...draft, slots: { ...draft.slots, [slot]: value === SILENT ? null : value } })
    return (
      <>
        <div className="grid gap-4 sm:grid-cols-2">
          {CHAT_DEDUCTION_SOUND_SLOTS.map((slot) => {
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
        <SaveBar label="音を保存する" busy={actions.busy} unsaved={unsaved} onSave={() => void actions.run(() => save(draft))} />
      </>
    )
  })()

  return (
    <Card>
      <CardHeader>
        <CardTitle>音</CardTitle>
        <CardDescription>
          場面ごとに合成ページで鳴らす音を選びます。BGM を流しているあいだ、配信の BGM は下がります。音声はアップロードのページで追加します。
          保存した音は、次にゲームが動いたときから鳴ります。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {actions.feedback}
        {soundFields}
      </CardContent>
    </Card>
  )
}
