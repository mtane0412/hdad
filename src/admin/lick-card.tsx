/**
 * ペロペロのカード（トリガーのページ）
 *
 * ペロペロ（issue #338）の、舌がアイコンに触れるたびに鳴らす効果音（issue #340）を選び、音量を決めて保存する。効果音はアップロード済みの音声から選ぶか
 * 「鳴らさない」にするだけにする（音声の追加はアップロードのページが受け持つ）。設定はペロペロとして1つだけで、トリガーと試し再生が共有する。
 *
 * 試し再生のボタンも置き、トリガーを待たずにペロペロを合成ページへ流させ、見栄えと置き場所と効果音を確かめられるようにする。
 * ボタンの上の入力欄に Twitch のログイン名を入れると、その人のアイコンを舐める。空ならアイコンの無い試しの相手を舐める。
 *
 * 保存と試し再生の結果・失敗は、トリガーの保存と取り違えないよう、このカードの中に出す。
 *
 * 注意: 値の検証は Worker だけが持つ（.claude/rules/implementation.md）。ここでは返ってきた問題点を項目の名前に読み替えて並べる。
 */
import { useEffect, useId, useState } from 'react'
import { LoadFailure } from '@/components/load-failure'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { useUnsavedChanges } from '@/app/router'
import { ApiError } from '@/core/api'
import type { LickSound } from '@/lick/sound'
import type { AdminApi, MediaItem } from './api'
import { errorMessage, usePageActions } from './page-actions'
import { VolumeField } from './volume-field'

/** このカードが使う Worker の呼び出し */
export type LickApi = Pick<AdminApi, 'lickSound' | 'saveLickSound' | 'playLickDemo'>

/** 項目の名前（Worker の問題点の読み替えにも使う） */
const FIELD_LABELS = { sound: '効果音（舌が触れるたびに鳴らす）', volume: '効果音の音量' } as const

/** 選択欄で「鳴らさない」を表す値（選択欄の値は文字列しか持てないので、null と空文字を行き来する） */
const SILENT = ''

type Loaded = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready' }

/**
 * Worker の問題点（`sound: …`・`volume: …`）の先頭を、画面の項目の名前に読み替える。
 * 知らない形の問題点は、そのまま出す（読み替えられないものを隠さない）
 */
const describeSoundProblem = (problem: string): string => {
  const [field = '', ...rest] = problem.split(': ')
  if (field === 'sound' || field === 'volume') return `${FIELD_LABELS[field]}: ${rest.join(': ')}`
  return problem
}

const failureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['ペロペロの効果音の設定に問題があります。直してから保存し直してください', ...error.problems.map((problem) => `・${describeSoundProblem(problem)}`)]
    : [errorMessage(error)]

interface LickCardProps {
  api: LickApi
  /** アップロード済みの素材（トリガーのページが読んだもの）。音声だけを選択肢にする */
  media: readonly MediaItem[]
}

export const LickCard = ({ api, media }: LickCardProps) => {
  const id = useId()
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [draft, setDraft] = useState<LickSound | null>(null)
  // 最後に保存した（または読み込んだ）設定。今の入力と食い違えば、未保存の変更があると知らせる
  const [saved, setSaved] = useState<LickSound | null>(null)
  const actions = usePageActions(failureLines)
  /** 試し再生で相手とみなす人のログイン名。空なら試しの相手を舐める。保存はしない */
  const [demoUserName, setDemoUserName] = useState('')

  useEffect(() => {
    let cancelled = false
    api.lickSound().then(
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

  const save = async (sound: LickSound): Promise<string> => {
    const result = await api.saveLickSound(sound)
    setSaved(result)
    // 保存を待つ間に入力が書き換えられていたら、その内容を応答で上書きしない（書き換えた分は次の保存で送られる）
    setDraft((current) => (current === sound ? result : current))
    return 'ペロペロの効果音を保存しました'
  }

  const playDemo = async (): Promise<string> =>
    `「${await api.playLickDemo(demoUserName.trim())}」をペロペロしました。オーバーレイに「ペロペロ」の素材を置いていれば流れます`

  const body = (() => {
    if (loaded.status === 'loading' || draft === null) {
      if (loaded.status === 'failed') return <LoadFailure title="ペロペロの効果音を表示できません" message={loaded.message} />
      return <Skeleton className="h-24 w-full" aria-label="ペロペロの効果音を読み込んでいます" />
    }
    // 一覧に無い素材が選ばれていれば、別の音に見せずにそのまま出す（素材は使われているあいだ消せないので、ふつうは起きない）
    const missing = draft.sound !== null && !audios.some((item) => item.id === draft.sound)
    return (
      <>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-sound`}>{FIELD_LABELS.sound}</Label>
            <NativeSelect
              id={`${id}-sound`}
              className="w-full"
              value={draft.sound ?? SILENT}
              onChange={(event) => {
                const { value } = event.currentTarget
                setDraft({ ...draft, sound: value === SILENT ? null : value })
              }}
            >
              <NativeSelectOption value={SILENT}>鳴らさない</NativeSelectOption>
              {missing && <NativeSelectOption value={draft.sound ?? SILENT}>見つからない素材（{draft.sound}）</NativeSelectOption>}
              {audios.map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <VolumeField id={`${id}-volume`} label={FIELD_LABELS.volume} volume={draft.volume} onChange={(volume) => setDraft({ ...draft, volume })} />
        </div>
        <div className="flex items-center gap-3">
          <Button type="button" disabled={actions.busy} onClick={() => void actions.run(() => save(draft))}>
            効果音を保存
          </Button>
          {unsaved && <span className="text-sm text-muted-foreground">未保存の変更があります</span>}
        </div>
      </>
    )
  })()

  return (
    <Card>
      <CardHeader>
        <CardTitle>ペロペロ</CardTitle>
        <CardDescription>
          チャンネルポイントの交換や、決まった人のその配信で最初の発言で、相手の Twitch のアイコンを3Dの舌が舐め上げる。トリガーの項目で「ペロペロする」を選ぶ。
          舌がアイコンに触れるたびに鳴らす効果音を選べる（音程は毎回少し変わる）。音声はアップロードのページで追加する。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {actions.feedback}
        {body}
        <p className="text-sm text-muted-foreground">
          トリガーを待たずに試しに流せる（舐め方は毎回ランダム。オーバーレイに「ペロペロ」の素材を置いておく）。効果音は保存したものが鳴るので、未保存の変更があるあいだは押せない。
          ユーザー名を入れると、その人のアイコンを舐める。空なら「視聴者（試し）」を舐める。
        </p>
        <div className="flex flex-col gap-2 sm:max-w-xs">
          <Label htmlFor={`${id}-demo-user`}>ペロペロの相手とみなすユーザー名（任意）</Label>
          <Input
            id={`${id}-demo-user`}
            value={demoUserName}
            placeholder="Twitch のログイン名"
            autoComplete="off"
            onChange={(event) => setDemoUserName(event.currentTarget.value)}
          />
        </div>
        {/* 試し再生は保存済みの効果音で鳴る。選び直した効果音を保存せずに流すと、聞き比べたつもりのものと食い違うので押させない */}
        <Button type="button" variant="outline" className="self-start" disabled={actions.busy || unsaved} onClick={() => void actions.run(playDemo)}>
          ペロペロを試しに流す
        </Button>
      </CardContent>
    </Card>
  )
}
