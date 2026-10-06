/**
 * 市町村紹介のカード（トリガーのページ）
 *
 * 市町村紹介の演出で鳴らす音を場面ごとに選び、BGM と効果音の音量を決めて保存する（issue #243）。
 * ナレーション（issue #255）の設定もこのカードの区画（town-tour-narration-section.tsx）で選ぶ。保存は音と別に行う。
 * 試し再生のボタンも置き、選んだ音と声をその場で聞き比べられるようにする。ボタンの横の入力欄にユーザー名を入れると、
 * その配信者をレイド元とみなして締めの共通点まで流す。レイドの人数も入れられる（issue #275。入力欄の値は保存しない）。
 *
 * 鳴らす場面（枠）はコードで固定で（src/town-tour/sound.ts の TOWN_TOUR_SOUND_SLOTS）、ここでは枠ごとに
 * アップロード済みの音声を選ぶか「鳴らさない」にするだけにする。音声の追加はアップロードのページが受け持つ。
 * 設定は市町村紹介として1つだけで、レイド・キーワードのトリガーと試し再生が共有する。
 *
 * 保存と試し再生の結果・失敗は、トリガーの保存と取り違えないよう、このカードの中に出す。
 *
 * 注意: 値の検証は Worker だけが持つ（.claude/rules/implementation.md）。ここでは返ってきた問題点を枠の名前に読み替えて並べる。
 */
import { useCallback, useEffect, useId, useState } from 'react'
import { LoadFailure } from '@/components/load-failure'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Slider } from '@/components/ui/slider'
import { useUnsavedChanges } from '@/app/router'
import { ApiError } from '@/core/api'
import { TOWN_TOUR_SOUND_SLOTS, type TownTourSound, type TownTourSoundSlot } from '@/town-tour/sound'
import type { AdminApi, MediaItem } from './api'
import { errorMessage, usePageActions } from './page-actions'
import { TownTourNarrationSection, type TownTourNarrationApi } from './town-tour-narration-section'

/** このカードが使う Worker の呼び出し */
export type TownTourSoundApi = Pick<AdminApi, 'townTourSound' | 'saveTownTourSound' | 'playTownTourDemo'> & TownTourNarrationApi

/** 枠ごとの選択欄の名前。括弧の中はいつ鳴るか */
const SLOT_LABELS: Readonly<Record<TownTourSoundSlot, string>> = {
  bgm: 'BGM（紹介のあいだ流す）',
  opening: '始まり（日本全体を映したとき）',
  zoom: 'ズーム（市町村へ寄り始めたとき）',
  landing: '着地（形を塗り終えたとき）',
  item: '項目ごと（大見出しと各項目が出るたび）',
  closing: '締め（配信者への振りが出たとき）',
}

/** 音量の項目の名前（Worker の問題点の読み替えにも使う） */
const VOLUME_LABELS = { bgmVolume: 'BGMの音量', effectVolume: '効果音の音量' } as const

/** 選択欄で「鳴らさない」を表す値（選択欄の値は文字列しか持てないので、null と空文字を行き来する） */
const SILENT = ''
/** 音量のつまみの最大（％）。保存する値は 0〜1 */
const MAX_VOLUME_PERCENT = 100

type Loaded = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready' }

/**
 * Worker の問題点（`slots.zoom: …`・`bgmVolume: …`）の先頭を、画面の項目の名前に読み替える。
 * 知らない形の問題点は、そのまま出す（読み替えられないものを隠さない）
 */
const describeSoundProblem = (problem: string): string => {
  const [field = '', ...rest] = problem.split(': ')
  const message = rest.join(': ')
  const slot = TOWN_TOUR_SOUND_SLOTS.find((candidate) => field === `slots.${candidate}`)
  if (slot !== undefined) return `${SLOT_LABELS[slot]}: ${message}`
  if (field === 'bgmVolume' || field === 'effectVolume') return `${VOLUME_LABELS[field]}: ${message}`
  return problem
}

const failureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['市町村紹介の音の設定に問題があります。直してから保存し直してください', ...error.problems.map((problem) => `・${describeSoundProblem(problem)}`)]
    : [errorMessage(error)]

/** 0〜1 の音量を、つまみと表示に使う％にする */
const toPercent = (volume: number): number => Math.round(volume * MAX_VOLUME_PERCENT)

interface VolumeFieldProps {
  id: string
  label: string
  volume: number
  onChange(volume: number): void
}

const VolumeField = ({ id, label, volume, onChange }: VolumeFieldProps) => (
  <div className="flex flex-col gap-2">
    <span id={id} className="text-sm leading-none font-medium">
      {label}
    </span>
    <div className="flex h-8 items-center gap-3">
      <Slider
        aria-labelledby={id}
        min={0}
        max={MAX_VOLUME_PERCENT}
        value={[toPercent(volume)]}
        onValueChange={(next) => onChange((Array.isArray(next) ? (next[0] ?? 0) : next) / MAX_VOLUME_PERCENT)}
      />
      <output className="w-12 text-right font-mono text-xs tabular-nums">{toPercent(volume)}%</output>
    </div>
  </div>
)

interface TownTourSoundCardProps {
  api: TownTourSoundApi
  /** アップロード済みの素材（トリガーのページが読んだもの）。音声だけを選択肢にする */
  media: readonly MediaItem[]
}

export const TownTourSoundCard = ({ api, media }: TownTourSoundCardProps) => {
  const id = useId()
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [draft, setDraft] = useState<TownTourSound | null>(null)
  // 最後に保存した（または読み込んだ）設定。今の入力と食い違えば、未保存の変更があると知らせる
  const [saved, setSaved] = useState<TownTourSound | null>(null)
  const actions = usePageActions(failureLines)
  // ナレーションの区画に未保存の変更があるか（試し再生を止めるため）
  const [narrationUnsaved, setNarrationUnsaved] = useState(false)
  /** 試し再生でレイド元とみなす配信者のログイン名（issue #275）。空なら見本の名前で流す。保存はしない */
  const [demoUserName, setDemoUserName] = useState('')
  /** 試し再生でレイド元が連れてきたとみなす人数の入力欄の値。空なら人数なしで流す。保存はしない */
  const [demoViewers, setDemoViewers] = useState('')
  const onNarrationUnsavedChange = useCallback((value: boolean) => setNarrationUnsaved(value), [])

  useEffect(() => {
    let cancelled = false
    api.townTourSound().then(
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

  const save = async (sound: TownTourSound): Promise<string> => {
    const result = await api.saveTownTourSound(sound)
    setSaved(result)
    // 保存を待つ間に入力が書き換えられていたら、その内容を応答で上書きしない（書き換えた分は次の保存で送られる）
    setDraft((current) => (current === sound ? result : current))
    return '市町村紹介の音を保存しました'
  }

  const playDemo = async (): Promise<string> =>
    `「${await api.playTownTourDemo(demoUserName.trim(), demoViewers.trim() === '' ? null : Number(demoViewers))}」を送りました。オーバーレイに「市町村紹介」の素材を置いていれば流れます`

  const body = (() => {
    if (loaded.status === 'loading' || draft === null) {
      if (loaded.status === 'failed') return <LoadFailure title="市町村紹介の音を表示できません" message={loaded.message} />
      return <Skeleton className="h-48 w-full" aria-label="市町村紹介の音を読み込んでいます" />
    }
    const updateSlot = (slot: TownTourSoundSlot, value: string): void =>
      setDraft({ ...draft, slots: { ...draft.slots, [slot]: value === SILENT ? null : value } })
    return (
      <>
        <div className="grid gap-4 sm:grid-cols-2">
          {TOWN_TOUR_SOUND_SLOTS.map((slot) => {
            const selected = draft.slots[slot]
            // 一覧に無い素材が選ばれていれば、別の音に見せずにそのまま出す（素材は使われているあいだ消せないので、ふつうは起きない）
            const missing = selected !== null && !audios.some((item) => item.id === selected)
            return (
              <div key={slot} className="flex flex-col gap-2">
                <Label htmlFor={`${id}-${slot}`}>{SLOT_LABELS[slot]}</Label>
                <NativeSelect
                  id={`${id}-${slot}`}
                  className="w-full"
                  value={selected ?? SILENT}
                  onChange={(event) => updateSlot(slot, event.currentTarget.value)}
                >
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
        <CardTitle>市町村紹介</CardTitle>
        <CardDescription>レイドやキーワードで流す市町村紹介の、場面ごとに鳴らす音とナレーションの声を選ぶ。音声はアップロードのページで追加する。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {actions.feedback}
        {body}
        <TownTourNarrationSection api={api} onUnsavedChange={onNarrationUnsavedChange} />
        <p className="text-sm text-muted-foreground">
          トリガーを待たずに試しに流せる（引く市町村はランダム。オーバーレイに「市町村紹介」の素材を置いておく）。音と声は保存したものが鳴るので、未保存の変更があるあいだは押せない。
          ユーザー名を入れると、その配信者がレイドしてきたものとみなして、締めの共通点と認定証の任命理由まで流す（OpenRouter の鍵が要る）。レイドの人数も入れると、連れてきた人数として共通点の材料にする。
        </p>
        <div className="flex flex-col gap-2 sm:max-w-xs">
          <Label htmlFor={`${id}-demo-user`}>レイド元とみなすユーザー名（任意）</Label>
          <Input
            id={`${id}-demo-user`}
            value={demoUserName}
            placeholder="Twitch のログイン名"
            autoComplete="off"
            onChange={(event) => setDemoUserName(event.currentTarget.value)}
          />
        </div>
        <div className="flex flex-col gap-2 sm:max-w-xs">
          <Label htmlFor={`${id}-demo-viewers`}>レイドの人数（任意）</Label>
          <Input
            id={`${id}-demo-viewers`}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={demoViewers}
            onChange={(event) => setDemoViewers(event.currentTarget.value)}
          />
        </div>
        {/* 試し再生は保存済みの音と声で鳴る。選び直した音や声を保存せずに流すと、聞き比べたつもりのものと食い違うので押させない */}
        <Button
          type="button"
          variant="outline"
          className="self-start"
          disabled={actions.busy || unsaved || narrationUnsaved}
          onClick={() => void actions.run(playDemo)}
        >
          市町村紹介を試しに流す
        </Button>
      </CardContent>
    </Card>
  )
}
