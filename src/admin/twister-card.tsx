/**
 * ツイスターのカード（トリガーのページ）
 *
 * ツイスター（issue #272）の対戦のあいだ流す BGM を選び、音量を決めて保存する。BGM はアップロード済みの音声から選ぶか
 * 「流さない」にするだけにする（音声の追加はアップロードのページが受け持つ）。設定はツイスターとして1つだけで、
 * レイドのトリガーと試し再生が共有する。対戦のあいだ配信の BGM は下がり、対戦が終わると戻る（合成ページと裏方のページが行う）。
 *
 * 試し再生のボタンも置き、レイドを待たずに試しの相手と配信者（自分のアイコン）の対戦を合成ページへ流させ、見栄えと置き場所と BGM を確かめられるようにする。
 * ボタンの横の入力欄にユーザー名を入れると、その配信者がレイドしてきたものとみなし、相手の顔にその人のアイコンを貼って流す。
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
import type { TwisterSound } from '@/twister/sound'
import type { AdminApi, MediaItem } from './api'
import { errorMessage, usePageActions } from './page-actions'
import { VolumeField } from './volume-field'

/** このカードが使う Worker の呼び出し */
export type TwisterApi = Pick<AdminApi, 'twisterSound' | 'saveTwisterSound' | 'playTwisterDemo'>

/** 項目の名前（Worker の問題点の読み替えにも使う） */
const FIELD_LABELS = { bgm: 'BGM（対戦のあいだ流す）', bgmVolume: 'BGMの音量' } as const

/** 選択欄で「流さない」を表す値（選択欄の値は文字列しか持てないので、null と空文字を行き来する） */
const SILENT = ''

type Loaded = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready' }

/**
 * Worker の問題点（`bgm: …`・`bgmVolume: …`）の先頭を、画面の項目の名前に読み替える。
 * 知らない形の問題点は、そのまま出す（読み替えられないものを隠さない）
 */
const describeSoundProblem = (problem: string): string => {
  const [field = '', ...rest] = problem.split(': ')
  if (field === 'bgm' || field === 'bgmVolume') return `${FIELD_LABELS[field]}: ${rest.join(': ')}`
  return problem
}

const failureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['ツイスターの BGM の設定に問題があります。直してから保存し直してください', ...error.problems.map((problem) => `・${describeSoundProblem(problem)}`)]
    : [errorMessage(error)]

interface TwisterCardProps {
  api: TwisterApi
  /** アップロード済みの素材（トリガーのページが読んだもの）。音声だけを選択肢にする */
  media: readonly MediaItem[]
}

export const TwisterCard = ({ api, media }: TwisterCardProps) => {
  const id = useId()
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [draft, setDraft] = useState<TwisterSound | null>(null)
  // 最後に保存した（または読み込んだ）設定。今の入力と食い違えば、未保存の変更があると知らせる
  const [saved, setSaved] = useState<TwisterSound | null>(null)
  const actions = usePageActions(failureLines)
  /** 試し再生で相手とみなす配信者のログイン名。空なら試しの相手で流す。保存はしない */
  const [demoUserName, setDemoUserName] = useState('')

  useEffect(() => {
    let cancelled = false
    api.twisterSound().then(
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

  const save = async (sound: TwisterSound): Promise<string> => {
    const result = await api.saveTwisterSound(sound)
    setSaved(result)
    // 保存を待つ間に入力が書き換えられていたら、その内容を応答で上書きしない（書き換えた分は次の保存で送られる）
    setDraft((current) => (current === sound ? result : current))
    return 'ツイスターの BGM を保存しました'
  }

  const playDemo = async (): Promise<string> =>
    `「${await api.playTwisterDemo(demoUserName.trim())}」の対戦を送りました。オーバーレイに「ツイスター」の素材を置いていれば流れます`

  const body = (() => {
    if (loaded.status === 'loading' || draft === null) {
      if (loaded.status === 'failed') return <LoadFailure title="ツイスターの BGM を表示できません" message={loaded.message} />
      return <Skeleton className="h-24 w-full" aria-label="ツイスターの BGM を読み込んでいます" />
    }
    // 一覧に無い素材が選ばれていれば、別の音に見せずにそのまま出す（素材は使われているあいだ消せないので、ふつうは起きない）
    const missing = draft.bgm !== null && !audios.some((item) => item.id === draft.bgm)
    return (
      <>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-bgm`}>{FIELD_LABELS.bgm}</Label>
            <NativeSelect
              id={`${id}-bgm`}
              className="w-full"
              value={draft.bgm ?? SILENT}
              onChange={(event) => {
                const { value } = event.currentTarget
                setDraft({ ...draft, bgm: value === SILENT ? null : value })
              }}
            >
              <NativeSelectOption value={SILENT}>流さない</NativeSelectOption>
              {missing && <NativeSelectOption value={draft.bgm ?? SILENT}>見つからない素材（{draft.bgm}）</NativeSelectOption>}
              {audios.map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <VolumeField id={`${id}-bgm-volume`} label={FIELD_LABELS.bgmVolume} volume={draft.bgmVolume} onChange={(bgmVolume) => setDraft({ ...draft, bgmVolume })} />
        </div>
        <div className="flex items-center gap-3">
          <Button type="button" disabled={actions.busy} onClick={() => void actions.run(() => save(draft))}>
            BGM を保存
          </Button>
          {unsaved && <span className="text-sm text-muted-foreground">未保存の変更があります</span>}
        </div>
      </>
    )
  })()

  return (
    <Card>
      <CardHeader>
        <CardTitle>ツイスター</CardTitle>
        <CardDescription>
          レイドしてきた配信者と自分が、3Dの人形でツイスターゲームをする。人形の顔には2人の Twitch のアイコンが貼られる。
          対戦のあいだ流す BGM を選べる（流しているあいだ配信の BGM は下がる）。音声はアップロードのページで追加する。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {actions.feedback}
        {body}
        <p className="text-sm text-muted-foreground">
          レイドを待たずに試しに流せる（指示と勝敗は毎回ランダム。オーバーレイに「ツイスター」の素材を置いておく）。BGM は保存したものが流れるので、未保存の変更があるあいだは押せない。
          ユーザー名を入れると、その配信者がレイドしてきたものとみなして、その人のアイコンで対戦する。空なら相手は「レイドした人（試し）」になる。
        </p>
        <div className="flex flex-col gap-2 sm:max-w-xs">
          <Label htmlFor={`${id}-demo-user`}>ツイスターの相手とみなすユーザー名（任意）</Label>
          <Input
            id={`${id}-demo-user`}
            value={demoUserName}
            placeholder="Twitch のログイン名"
            autoComplete="off"
            onChange={(event) => setDemoUserName(event.currentTarget.value)}
          />
        </div>
        {/* 試し再生は保存済みの BGM で流れる。選び直した BGM を保存せずに流すと、聞き比べたつもりのものと食い違うので押させない */}
        <Button type="button" variant="outline" className="self-start" disabled={actions.busy || unsaved} onClick={() => void actions.run(playDemo)}>
          ツイスターを試しに流す
        </Button>
      </CardContent>
    </Card>
  )
}
