/**
 * VRMのカード（トリガーのページ）
 *
 * VRMの演出（issue #358）で出すキャラクターの VRM を、アップロード済みの VRM から1つ選んで保存する（VRM の追加はアップロードのページが受け持つ）。
 * 設定は VRMの演出として1つだけで、どのトリガーと試し再生も同じ VRM を出す。
 *
 * 試し再生のボタンも置き、トリガーを待たずに演出を合成ページへ流させ、見栄えと置き場所と OBS での重さを確かめられるようにする。
 *
 * 保存と試し再生の結果・失敗は、トリガーの保存と取り違えないよう、このカードの中に出す。
 *
 * 注意: 値の検証は Worker だけが持つ（.claude/rules/implementation.md）。ここでは返ってきた問題点を項目の名前に読み替えて並べる。
 */
import { useEffect, useId, useState } from 'react'
import { SaveBar } from '@/components/save-bar'
import { LoadFailure } from '@/components/load-failure'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { useUnsavedChanges } from '@/app/router'
import { ApiError } from '@/core/api'
import type { VrmModel } from '@/vrm/model'
import type { AdminApi, MediaItem } from './api'
import { errorMessage, usePageActions } from './page-actions'

/** このカードが使う Worker の呼び出し */
export type VrmApi = Pick<AdminApi, 'vrmModel' | 'saveVrmModel' | 'playVrmDemo'>

/** 項目の名前（Worker の問題点の読み替えにも使う） */
const MODEL_LABEL = '出す VRM'

/** 選択欄で「選ばない」を表す値（選択欄の値は文字列しか持てないので、null と空文字を行き来する） */
const NONE = ''

type Loaded = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready' }

/**
 * Worker の問題点（`model: …`）の先頭を、画面の項目の名前に読み替える。
 * 知らない形の問題点は、そのまま出す（読み替えられないものを隠さない）
 */
const describeModelProblem = (problem: string): string => {
  const [field = '', ...rest] = problem.split(': ')
  return field === 'model' ? `${MODEL_LABEL}: ${rest.join(': ')}` : problem
}

const failureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['VRMの演出の設定に問題があります。直してから保存し直してください', ...error.problems.map((problem) => `・${describeModelProblem(problem)}`)]
    : [errorMessage(error)]

interface VrmCardProps {
  api: VrmApi
  /** アップロード済みの素材（トリガーのページが読んだもの）。VRM だけを選択肢にする */
  media: readonly MediaItem[]
}

export const VrmCard = ({ api, media }: VrmCardProps) => {
  const id = useId()
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [draft, setDraft] = useState<VrmModel | null>(null)
  // 最後に保存した（または読み込んだ）設定。今の入力と食い違えば、未保存の変更があると知らせる
  const [saved, setSaved] = useState<VrmModel | null>(null)
  const actions = usePageActions(failureLines)

  useEffect(() => {
    let cancelled = false
    api.vrmModel().then(
      (model) => {
        if (cancelled) return
        setDraft(model)
        setSaved(model)
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

  const unsaved = draft !== null && draft.model !== saved?.model
  useUnsavedChanges(unsaved)

  const vrms = media.filter((item) => item.kind === 'vrm')

  const save = async (model: VrmModel): Promise<string> => {
    const result = await api.saveVrmModel(model)
    setSaved(result)
    // 保存を待つ間に入力が書き換えられていたら、その内容を応答で上書きしない（書き換えた分は次の保存で送られる）
    setDraft((current) => (current === model ? result : current))
    return 'VRMの演出で出す VRM を保存しました'
  }

  const playDemo = async (): Promise<string> => {
    await api.playVrmDemo()
    return 'VRMの演出を流しました。オーバーレイに「VRM」の素材を置いていれば流れます'
  }

  const body = (() => {
    if (loaded.status === 'loading' || draft === null) {
      if (loaded.status === 'failed') return <LoadFailure title="VRMの演出の設定を表示できません" message={loaded.message} />
      return <Skeleton className="h-16 w-full" aria-label="VRMの演出の設定を読み込んでいます" />
    }
    // 一覧に無い素材が選ばれていれば、別の VRM に見せずにそのまま出す（素材は使われているあいだ消せないので、ふつうは起きない）
    const missing = draft.model !== null && !vrms.some((item) => item.id === draft.model)
    return (
      <>
        <div className="flex flex-col gap-2 sm:max-w-sm">
          <Label htmlFor={`${id}-model`}>{MODEL_LABEL}</Label>
          <NativeSelect
            id={`${id}-model`}
            className="w-full"
            value={draft.model ?? NONE}
            onChange={(event) => {
              const { value } = event.currentTarget
              setDraft({ model: value === NONE ? null : value })
            }}
          >
            <NativeSelectOption value={NONE}>選ばない</NativeSelectOption>
            {missing && <NativeSelectOption value={draft.model ?? NONE}>見つからない素材（{draft.model}）</NativeSelectOption>}
            {vrms.map((item) => (
              <NativeSelectOption key={item.id} value={item.id}>
                {item.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <SaveBar label="VRMを保存する" busy={actions.busy} unsaved={unsaved} onSave={() => void actions.run(() => save(draft))} />
      </>
    )
  })()

  return (
    <Card>
      <CardHeader>
        <CardTitle>VRM</CardTitle>
        <CardDescription>
          選んだ VRM のキャラクターを、オーバーレイの素材「VRM」にマスコットとして立たせておく。トリガーの項目で「VRMを出す」を選ぶと、その項目に合った反応（お礼・大喜び・手を振る・うなずく）をその場でする（どの項目にも置ける）。
          VRM はアップロードのページで追加する。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {actions.feedback}
        {body}
        <p className="text-sm text-muted-foreground">
          トリガーを待たずに試しに反応させられる（反応の種類と動き方は毎回ランダム。オーバーレイに「VRM」の素材を置いておく）。VRM は保存したものが出るので、未保存の変更があるあいだと、VRM
          を選んでいないあいだは押せない。
        </p>
        {/* 試し再生は保存済みの VRM で流れる。選び直した VRM を保存せずに流すと、見比べたつもりのものと食い違うので押させない */}
        <Button
          type="button"
          variant="outline"
          className="self-start"
          disabled={actions.busy || unsaved || saved?.model == null}
          onClick={() => void actions.run(playDemo)}
        >
          VRMを試しに流す
        </Button>
      </CardContent>
    </Card>
  )
}
