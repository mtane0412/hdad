/**
 * トリガーのページ
 *
 * OBS用のURLと、「どのきっかけで何をするか」（トリガー）の操作盤を出す。きっかけは既定メニューから選び、
 * イベント種別と条件の組み立てはしない（このツールは汎用のノーコード自動化を目指していないため）。素材の追加と削除はアップロードのページ
 * （media-page.tsx）が受け持ち、ここでは置いてある素材から選ぶだけにする。ログインの確認とログアウトは
 * アプリの枠（src/app/app.tsx）が受け持つので、ここではログイン済みを前提にする。
 * 画面の状態（素材・報酬・入力中のトリガー）はここで持ち、Workerの呼び出しは api.ts、入力欄の値の変換は form.ts、
 * 操作の実行と結果の表示は page-actions.tsx に任せる。
 *
 * 注意: 失敗は黙って無視せず、画面の上部に理由を出す（Fail-Fast）。
 * 素材や保存済みの設定を取得できなければ操作盤を出さない。報酬の一覧とbotの接続状態だけ取得できないときは、操作盤は出したまま理由を出す。
 */
import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'
import { Link } from '@/app/router'
import type { BotApi, BotStatus } from '@/bot/api'
import { ApiError } from '@/core/api'
import { isAnnouncementColor, type AdminApi, type MediaItem, type Reward, type TriggerKind } from './api'
import {
  colorOptions,
  createDraft,
  describeProblem,
  kindLabels,
  menuGroups,
  menuLabel,
  overlayUrl,
  placeholdersFor,
  rewardOptions,
  hasAnyAction,
  rowActionLabels,
  rowParamSummary,
  toDraft,
  toTriggerInputs,
  withFixedRows,
  type MenuItem,
  type MenuPhase,
  type SelectOption,
  type TriggerDraft,
} from './form'
import { errorMessage, usePageActions } from './page-actions'

/** 文言欄の入力例。メニュー項目ごとに、使える差し込み語だけを使った例を出す */
const MESSAGE_PLACEHOLDERS: Readonly<Record<TriggerKind, string>> = {
  newViewer: '{user} さん、はじめまして！',
  comeback: '{user} さん、お久しぶりです！',
  welcome: '{user} さん、おかえりなさい！',
  everyMessage: '{user} さんが「{message}」と言いました',
  keyword: '{user} さんが「{message}」と言いました',
  fromUser: '{user} さんが来ました',
  reward: '{user} さんが「{reward}」を交換しました',
  follow: '{user} さんがフォローしました',
  subscribe: '{user} さんがティア{tier}でサブスクしました',
  resubscribe: '{user} さんが{months}か月目のサブスク（ティア{tier}）',
  raid: '{user} さんが{viewers}人でレイドしました',
  adBreakBegin: 'ここで{duration}秒の広告が入ります',
  adBreakEnd: '広告が終わりました。おかえりなさい',
}
const MIN_DURATION_SECONDS = 1
const MAX_DURATION_SECONDS = 60
const MAX_VOLUME_PERCENT = 100
const MAX_MESSAGE_LENGTH = 200
/** Twitchのユーザー名（login）の上限。Workerの検証と同じ値 */
const MAX_LOGIN_LENGTH = 25
/** チャットに送る文言の上限（Twitchのチャット1通の上限） */
const MAX_CHAT_MESSAGE_LENGTH = 500
/** AIへの指示の上限（worker/alert-config.ts の検証と同じ値） */
const MAX_AI_INSTRUCTION_LENGTH = 1000
/** 空いた日数の条件に入れられる日数の範囲（worker/alert-config.ts の検証と同じ値） */
const MIN_RETURNING_DAYS = 1
const MAX_RETURNING_DAYS = 365
/** ブラウザソースに設定する推奨の大きさ（配信のキャンバスと同じ大きさ。素材は中央に出るため、キャンバス全体を覆う） */
const OVERLAY_SIZE = { width: 1920, height: 1080 }

/**
 * 失敗の理由を、画面に出す行にする。設定の問題点があれば、1行ずつ並べる。
 *
 * Workerは問題点に「送った一覧の何番目か」を付けてくるが、画面の一覧は固定なので番号では場所が伝わらない。
 * 送った順の項目の名前を渡して読み替える。
 */
const failureLines = (error: unknown, labels: readonly string[]): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['トリガーの設定に問題があります。直してから保存し直してください', ...error.problems.map((problem) => `・${describeProblem(problem, labels)}`)]
    : [errorMessage(error)]

const Select = ({ id, options, value, onChange }: { id: string; options: readonly SelectOption[]; value: string; onChange(value: string): void }) => (
  <NativeSelect id={id} className="w-full" value={value} onChange={(event) => onChange(event.currentTarget.value)}>
    {options.map((option) => (
      <NativeSelectOption key={option.value} value={option.value}>
        {option.label}
      </NativeSelectOption>
    ))}
  </NativeSelect>
)

/**
 * 広告の絞り込みの選択肢。
 *
 * 選択欄の値は文字列しか持てないので、真偽値・null との行き来はここで行う（空文字が「どちらでも」）。
 * 配信者が手で打った広告は自分で告知できるので、告知したいのはふつう自動で入った広告のほうである。
 */
const AUTOMATIC_OPTIONS: readonly SelectOption[] = [
  { value: 'true', label: '自動で入った広告だけ' },
  { value: 'false', label: '配信者が手動で打った広告だけ' },
  { value: '', label: '自動・手動どちらでも' },
]

/**
 * メニュー項目1つぶんの枠の見た目。
 *
 * 1行だけの項目も複数の設定を持てる項目も同じ枠に入れて、一覧の中で見た目が2種類に分かれないようにする。
 * 枠は区分のカードの中に入るので、カードの見た目（地色・影）は持たせない（カードの中にカードが並んで見えてしまう）。
 */
const ITEM_BOX = 'overflow-hidden rounded-lg border'

/** メニュー項目に添える注意書き。一覧の項目の見出しの下に出す */
const KIND_NOTES: Partial<Readonly<Record<TriggerKind, string>>> = {
  newViewer: '記録を始める前から来ている常連も「初めて」と扱われます。',
  welcome: '配信中の発言だけが対象です。',
}

interface TriggerParamFieldProps {
  /** 入力欄のIDの前置き */
  idPrefix: string
  draft: TriggerDraft
  rewards: readonly Reward[]
  onChange(patch: Partial<TriggerDraft>): void
}

/**
 * メニュー項目が要求するパラメータ1つの入力欄。
 *
 * 項目によって入れるものが違うので、項目ごとに出し分ける（報酬は選択欄、ユーザー名と言葉は文字、日数は数、広告は三択）。
 * パラメータを持たない項目では何も出さない（きっかけは一覧の項目そのものが表している）。
 */
const TriggerParamField = ({ idPrefix, draft, rewards, onChange }: TriggerParamFieldProps) => (
  <>
    {draft.kind === 'reward' && (
      <div className="flex flex-col gap-2 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-reward`}>対象の報酬</Label>
        <Select id={`${idPrefix}-reward`} options={rewardOptions(rewards, draft.rewardId)} value={draft.rewardId} onChange={(rewardId) => onChange({ rewardId })} />
      </div>
    )}

    {draft.kind === 'fromUser' && (
      <div className="flex flex-col gap-2 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-login`}>対象のユーザー名</Label>
        <Input
          id={`${idPrefix}-login`}
          type="text"
          maxLength={MAX_LOGIN_LENGTH}
          value={draft.login}
          placeholder="tanenobu"
          onChange={(event) => onChange({ login: event.currentTarget.value })}
        />
        <p className="text-xs text-muted-foreground">表示名ではなく、小文字のログイン名で指定します。</p>
      </div>
    )}

    {draft.kind === 'keyword' && (
      <div className="flex flex-col gap-2 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-contains`}>発言に含まれる言葉</Label>
        <Input
          id={`${idPrefix}-contains`}
          type="text"
          maxLength={MAX_CHAT_MESSAGE_LENGTH}
          value={draft.contains}
          placeholder="おはよう"
          onChange={(event) => onChange({ contains: event.currentTarget.value })}
        />
        <p className="text-xs text-muted-foreground">部分一致。大文字小文字は区別しません。</p>
      </div>
    )}

    {draft.kind === 'comeback' && (
      <div className="flex flex-col gap-2 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-days`}>前の発言から空いた日数</Label>
        <Input
          id={`${idPrefix}-days`}
          type="number"
          min={MIN_RETURNING_DAYS}
          max={MAX_RETURNING_DAYS}
          value={draft.days}
          onChange={(event) => onChange({ days: event.currentTarget.value })}
        />
        <p className="text-xs text-muted-foreground">{MIN_RETURNING_DAYS}〜{MAX_RETURNING_DAYS}日。初めて来た人には当てはまりません。</p>
      </div>
    )}

    {(draft.kind === 'adBreakBegin' || draft.kind === 'adBreakEnd') && (
      <div className="flex flex-col gap-2 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-automatic`}>対象の広告</Label>
        <Select id={`${idPrefix}-automatic`} options={AUTOMATIC_OPTIONS} value={draft.automatic} onChange={(automatic) => onChange({ automatic })} />
      </div>
    )}
  </>
)

interface ActionFieldsProps {
  draft: TriggerDraft
  media: readonly MediaItem[]
  /** 効果のまとまりの見出し。1つの行に効果のまとまりが1つしかなければ null（囲みを作らない） */
  heading: string | null
  onChange(draft: TriggerDraft): void
}

/**
 * イベント種別1つぶんの効果の入力欄。
 *
 * 種類ごとに実行者が違う（アラートはオーバーレイ、チャットとアナウンスはWorkerがbotとして送る）。
 * 広告のように1つの行が2つのイベント種別を持つときは、見出し付きの囲みにして
 * どちらのときの効果かを分かるようにする（入力欄のIDはここで作るので、同じ行に2つ並んでも重ならない）。
 */
const ActionFields = ({ draft, media, heading, onChange }: ActionFieldsProps) => {
  const id = useId()
  const update = (patch: Partial<TriggerDraft>): void => onChange({ ...draft, ...patch })
  const mediaOptions = media.map((item) => ({ value: item.id, label: `${item.name}（${kindLabels[item.kind]}）` }))

  const fields = (
    <>
      {/* ここから下は、そのきっかけで行う効果。種類ごとに実行者が違う（アラートはオーバーレイ、チャットはWorker） */}
      <div className="flex flex-col gap-4 rounded-md border border-dashed p-3 sm:col-span-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${id}-alert-enabled`}
            checked={draft.alertEnabled}
            // 素材が未選択のまま出すことにすると、選択欄には最初の素材が見えているのに保存時に拒まれる。
            // そこで、出すことにした時点で選択欄が見せているとおりの素材（先頭）を選んでおく
            onCheckedChange={(checked) =>
              update(checked === true ? { alertEnabled: true, mediaId: draft.mediaId === '' ? (media[0]?.id ?? '') : draft.mediaId } : { alertEnabled: false })
            }
          />
          <Label htmlFor={`${id}-alert-enabled`}>アラートを出す</Label>
        </div>
        {draft.alertEnabled && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-media`}>素材</Label>
              <Select id={`${id}-media`} options={mediaOptions} value={draft.mediaId} onChange={(mediaId) => update({ mediaId })} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-duration`}>表示時間（1〜60秒）</Label>
              <Input
                id={`${id}-duration`}
                type="number"
                min={MIN_DURATION_SECONDS}
                max={MAX_DURATION_SECONDS}
                value={draft.durationSeconds}
                onChange={(event) => update({ durationSeconds: event.currentTarget.value })}
              />
            </div>
            <div className="flex flex-col gap-2">
              <span id={`${id}-volume`} className="text-sm leading-none font-medium">
                音量
              </span>
              <div className="flex h-8 items-center gap-3">
                <Slider
                  aria-labelledby={`${id}-volume`}
                  min={0}
                  max={MAX_VOLUME_PERCENT}
                  value={[Number(draft.volumePercent)]}
                  onValueChange={(next) => update({ volumePercent: String(Array.isArray(next) ? next[0] : next) })}
                />
                <output className="w-12 text-right font-mono text-xs tabular-nums">{draft.volumePercent}%</output>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor={`${id}-message`}>文言（空欄なら出さない）</Label>
              <Input
                id={`${id}-message`}
                type="text"
                maxLength={MAX_MESSAGE_LENGTH}
                value={draft.message}
                placeholder={MESSAGE_PLACEHOLDERS[draft.kind]}
                onChange={(event) => update({ message: event.currentTarget.value })}
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4 rounded-md border border-dashed p-3 sm:col-span-2">
        <div className="flex items-center gap-2">
          {/* 固定文言とAIの文面はどちらもbotの発言として送られるので、並べると同じ発言に2通返ってしまう（Workerも保存を拒む） */}
          <Checkbox
            id={`${id}-chat-enabled`}
            checked={draft.chatEnabled}
            onCheckedChange={(checked) => update({ chatEnabled: checked === true, ...(checked === true ? { aiChatEnabled: false } : {}) })}
          />
          <Label htmlFor={`${id}-chat-enabled`}>チャットに送る</Label>
        </div>
        {draft.chatEnabled && (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-chat-message`}>チャットに送る文言</Label>
            <Input
              id={`${id}-chat-message`}
              type="text"
              maxLength={MAX_CHAT_MESSAGE_LENGTH}
              value={draft.chatMessage}
              placeholder={MESSAGE_PLACEHOLDERS[draft.kind]}
              onChange={(event) => update({ chatMessage: event.currentTarget.value })}
            />
            {/* 送るのは接続しているbotアカウント。未接続だと何も送られないので、どこで接続するかを添える */}
            <p className="text-xs text-muted-foreground">接続しているbotが送ります。</p>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4 rounded-md border border-dashed p-3 sm:col-span-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${id}-aichat-enabled`}
            checked={draft.aiChatEnabled}
            onCheckedChange={(checked) => update({ aiChatEnabled: checked === true, ...(checked === true ? { chatEnabled: false } : {}) })}
          />
          <Label htmlFor={`${id}-aichat-enabled`}>AIに文面を作らせて送る</Label>
        </div>
        {draft.aiChatEnabled && (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-aichat-instruction`}>AIへの指示</Label>
            <Textarea
              id={`${id}-aichat-instruction`}
              maxLength={MAX_AI_INSTRUCTION_LENGTH}
              value={draft.aiChatInstruction}
              placeholder="初めて来てくれた人に、配信の内容を一言添えて歓迎してください"
              onChange={(event) => update({ aiChatInstruction: event.currentTarget.value })}
            />
            {/* 差し込み語は使わない（文面はAIが書く）ことと、材料に何が渡るかを知らせる */}
            <p className="text-xs text-muted-foreground">
              接続しているbotが送ります。文面はそのつどAIが書くので、差し込み語は要りません。
              相手の名前・発言の本文・視聴者の記録・配信のあらすじを材料に渡します。
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4 rounded-md border border-dashed p-3 sm:col-span-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${id}-announce-enabled`}
            checked={draft.announceEnabled}
            onCheckedChange={(checked) => update({ announceEnabled: checked === true })}
          />
          <Label htmlFor={`${id}-announce-enabled`}>アナウンスを送る</Label>
        </div>
        {draft.announceEnabled && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor={`${id}-announce-message`}>アナウンスの文言</Label>
              <Input
                id={`${id}-announce-message`}
                type="text"
                maxLength={MAX_CHAT_MESSAGE_LENGTH}
                value={draft.announceMessage}
                placeholder={MESSAGE_PLACEHOLDERS[draft.kind]}
                onChange={(event) => update({ announceMessage: event.currentTarget.value })}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-announce-color`}>アナウンスの色</Label>
              {/* 選択肢は色だけなので isAnnouncementColor は必ず通る。型を絞るための確認 */}
              <Select
                id={`${id}-announce-color`}
                options={colorOptions}
                value={draft.announceColor}
                onChange={(color) => isAnnouncementColor(color) && update({ announceColor: color })}
              />
            </div>
            {/* アナウンスは普通の発言と違い、botがモデレーターでないとTwitchに拒否される */}
            <p className="text-xs text-muted-foreground sm:col-span-2">接続しているbotに、モデレーター権限が必要です。</p>
          </div>
        )}
      </div>

      {/* 選んだメニュー項目のイベントに存在しない語は置き換わらないため、使える語をその場で知らせる（アラートとチャットで同じ語を使う） */}
      <p className="text-xs text-muted-foreground sm:col-span-2">使える差し込み語: {placeholdersFor(draft.kind).join('・')}</p>
    </>
  )

  if (heading === null) return fields
  return (
    <fieldset className="grid gap-4 rounded-md border p-3 sm:col-span-2 sm:grid-cols-2">
      <legend className="px-1 text-sm font-medium">{heading}</legend>
      {fields}
    </fieldset>
  )
}

/** 行の中の、イベント種別1つぶん。効果はここが持ち、絞り込みのパラメータは行で共通である */
interface RowPhase {
  phase: MenuPhase
  /** 入力欄の一覧の中での位置。開閉と書き換えの目印に使う */
  position: number
  draft: TriggerDraft
  onChange(draft: TriggerDraft): void
}

interface TriggerRowProps {
  /** 行の呼び名（読み上げと操作の目印）。項目が1行だけなら項目の名前、複数持てる項目なら何番目の設定か */
  label: string
  /** 見出しに出す項目の名前。複数持てる項目では、行の見出しが絞り込みの文言になるので渡さない */
  heading: string | null
  /** 見出しの下に小さく出す、その項目が何をきっかけにするかの説明。複数持てる項目では枠の見出しに出ているので渡さない */
  description: string | null
  /** 見出しの下に出す注意書き。無ければ null（開かなくても読めるように、折りたたみの外に出す） */
  note: string | null
  /** この行が受け持つイベント種別。ふつうは1つで、広告だけが開始と終了の2つを持つ */
  phases: readonly RowPhase[]
  media: readonly MediaItem[]
  rewards: readonly Reward[]
  /** 入力欄を開いているか。開くのは1件ずつなので、どれを開くかは一覧を持つページが決める */
  open: boolean
  onToggle(): void
  /** その行を外す。外せない行（複数持てない項目の行）では null。効果をすべて外せば何も起きない */
  onRemove: (() => void) | null
  /** 行の枠の見た目。1行だけの項目ではその行が項目の枠そのもの、複数持てる項目では枠の中で区切り線だけを持つ */
  className: string
}

/**
 * トリガー1行ぶんの操作盤。
 *
 * 項目が多いので、ふだんは要約だけを見出しに出して折りたたみ、見出しを押したときだけ入力欄を開く。
 * 効果をひとつも持たない行は保存されないので、要約には「効果なし」と出す。
 */
const TriggerRow = ({ label, heading, description, note, phases, media, rewards, open, onToggle, onRemove, className }: TriggerRowProps) => {
  const id = useId()
  // 絞り込みのパラメータは行で共通なので、先頭のイベント種別の値を見せ、書き換えはすべての種別へ配る
  // （広告の「自動で入ったものだけ」を開始と終了で食い違わせないため）
  const first = phases[0]
  const updateParam = (patch: Partial<TriggerDraft>): void => phases.forEach((phase) => phase.onChange({ ...phase.draft, ...patch }))
  const param = first === undefined ? null : rowParamSummary(first.draft, rewards)
  // 行の呼び名は、1行だけの項目では項目の名前、複数持てる項目では絞り込みの文言にする
  // （項目の名前は枠の見出しに出ているので、繰り返さない）
  const title = heading ?? (param === null || param === '' ? 'まだ決めていません' : param)
  const withActions = phases.map((phase) => ({ phase, actions: rowActionLabels(phase.draft) })).filter(({ actions }) => actions.length > 0)
  // 絞り込みの入力欄は行に1つしかないので、イベント種別ごとに違う値が保存されていると、先頭の種別の値しか画面に出ない。
  // 保存しても食い違いはそのまま残る（送る値は種別ごとに持っているため）ので、黙って寄せも直しもせず、選び直せば揃うことを知らせる（Fail-Fast）
  const conflicted = new Set(phases.map((phase) => rowParamSummary(phase.draft, rewards))).size > 1

  return (
    <li aria-label={label} className={className}>
      <div className="flex items-center gap-1 p-2">
        <Button
          type="button"
          variant="ghost"
          className="h-auto min-w-0 flex-1 justify-start gap-2 py-1.5 font-normal"
          aria-expanded={open}
          aria-controls={`${id}-detail`}
          onClick={onToggle}
        >
          <ChevronDown aria-hidden="true" className={open ? 'rotate-180' : ''} />
          {/* 読み上げでは、どの行の見出しかが分かるように呼び名から始める（見出しに出ていない複数持ての行だけ） */}
          {heading === null && <span className="sr-only">{label}:</span>}
          <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
            <span className="truncate font-medium">{title}</span>
            {description !== null && <span className="truncate text-xs font-normal text-muted-foreground">{description}</span>}
            {/* 1行だけの項目でも絞り込みを持つことがある（久しぶりの人の日数・広告の自動と手動） */}
            {heading !== null && param !== null && <span className="truncate text-xs font-normal text-muted-foreground">{param}</span>}
          </span>
          {/* 効果は文につながず、ひとつずつバッジで出す（付いているかどうかを文末まで読まずに済ませる）。
              広告のように効果のまとまりが2つある行では、どちらのときのものかを短い名前で添える */}
          <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            {withActions.length === 0 ? (
              <span className="text-xs text-muted-foreground">効果なし</span>
            ) : (
              withActions.map(({ phase, actions }) => (
                <span key={phase.position} className="flex items-center gap-1">
                  {phase.phase.summary !== null && <span className="text-xs text-muted-foreground">{phase.phase.summary}</span>}
                  {actions.map((action) => (
                    <Badge key={action} variant="secondary">
                      {action}
                    </Badge>
                  ))}
                </span>
              ))
            )}
          </span>
        </Button>
        {onRemove !== null && (
          <Button type="button" variant="ghost" size="icon" aria-label={`${label}を外す`} className="text-destructive" onClick={onRemove}>
            <Trash2 aria-hidden="true" />
          </Button>
        )}
      </div>
      {note !== null && <p className="px-3 pb-2 text-xs text-muted-foreground">{note}</p>}
      {conflicted && (
        <p className="px-3 pb-2 text-xs text-destructive">
          対象の広告が、始まったときと終わったときで食い違って保存されています（上は始まったときの設定）。揃えるには選び直してください。
        </p>
      )}
      {open && (
        <div id={`${id}-detail`} className="grid gap-4 border-t p-4 sm:grid-cols-2">
          {/* きっかけは一覧の項目そのものなので、ここで出すのは絞り込みのパラメータだけである */}
          {first !== undefined && <TriggerParamField idPrefix={id} draft={first.draft} rewards={rewards} onChange={updateParam} />}

          {/* 効果は、そのイベント種別ごとに分けて持つ。広告だけは開始と終了の2つが1つの行に並ぶ */}
          {phases.map((phase) => (
            <ActionFields
              key={phase.position}
              draft={phase.draft}
              media={media}
              heading={phase.phase.heading}
              onChange={phase.onChange}
            />
          ))}
        </div>
      )}
    </li>
  )
}

interface TriggerItemProps {
  item: MenuItem
  /**
   * この項目の行。item.phases と同じ並びで、イベント種別ごとに drafts の添字と入力欄の値を持つ。
   *
   * ふつうは1つだが、広告は開始と終了の2つを持つ。同じ添字どうしが1つの行になる。
   */
  rowsByPhase: readonly (readonly { position: number; draft: TriggerDraft }[])[]
  media: readonly MediaItem[]
  rewards: readonly Reward[]
  openPosition: number | null
  busy: boolean
  onToggle(position: number): void
  onChange(position: number, draft: TriggerDraft): void
  onRemove(position: number): void
  onAdd(): void
}

/**
 * 一覧の項目1つ。
 *
 * 配信者はトリガーを作らず、並んでいる出来事に効果を足していく。そのため項目は常に一覧に出る。
 * 1行だけの項目も複数の設定を持てる項目も同じ枠（ITEM_BOX）に入れて、一覧の中で見た目が2種類に分かれないようにする。
 * 絞り込みのパラメータを持たない項目はちょうど1行で、その行が枠そのものになる
 * （見出しを2段重ねると、1行しかない項目でも入れ子があるように見えてしまう）。
 * パラメータを持つ項目は、配信者が足したぶんだけ行が並ぶ（報酬ごとに違う効果を付けられるようにするため）。
 */
const TriggerItem = ({ item, rowsByPhase, media, rewards, openPosition, busy, onToggle, onChange, onRemove, onAdd }: TriggerItemProps) => {
  // 同じ添字のイベント種別どうしを1つの行にまとめる（広告の開始と終了は同じ行に並ぶ）
  const rowCount = Math.max(0, ...rowsByPhase.map((rows) => rows.length))
  const rows: RowPhase[][] = Array.from({ length: rowCount }, (_, index) =>
    item.phases.flatMap((phase, phaseIndex) => {
      const entry = rowsByPhase[phaseIndex]?.[index]
      if (entry === undefined) return []
      return [{ phase, position: entry.position, draft: entry.draft, onChange: (next: TriggerDraft) => onChange(entry.position, next) }]
    }),
  )

  const row = (phases: RowPhase[], label: string, heading: string | null, removable: boolean, className: string) => {
    const first = phases[0]
    if (first === undefined) return null
    return (
      <TriggerRow
        key={first.position}
        label={label}
        heading={heading}
        description={heading === null ? null : item.description}
        note={heading === null ? null : (KIND_NOTES[item.kind] ?? null)}
        phases={phases}
        media={media}
        rewards={rewards}
        // 開閉の目印は行の先頭のイベント種別の位置（広告では開始の位置）にする
        open={openPosition === first.position}
        onToggle={() => onToggle(first.position)}
        // 外せるのは複数の設定を持てる項目の行だけで、それはイベント種別を1つしか持たない
        onRemove={removable ? () => onRemove(first.position) : null}
        className={className}
      />
    )
  }

  // ちょうど1行のときは、その行が項目の枠そのものになる。その行は外せない
  const only = rows[0]
  if (!item.multiple && rowCount === 1 && only !== undefined) return row(only, item.label, item.label, false, ITEM_BOX)

  // 複数持てない項目に設定が2つ以上あるのは画面からは作れない形だが、KVを手で直せば起こりうる。
  // 1つ目だけを出すと、2つ目は画面に出ないまま保存され続けてしまうので、すべて出して外せるようにする
  const duplicated = !item.multiple && rowCount > 1
  const note = KIND_NOTES[item.kind] ?? null

  return (
    <li aria-label={item.label} className={ITEM_BOX}>
      <div className="flex flex-col gap-0.5 p-3">
        <span className="text-sm font-medium">{item.label}</span>
        <span className="text-xs text-muted-foreground">{item.description}</span>
        {note !== null && <span className="text-xs text-muted-foreground">{note}</span>}
        {duplicated && (
          <span className="text-xs text-destructive">設定が2つ以上あります。両方の効果が起きるので、ひとつだけ残してください。</span>
        )}
      </div>
      {rowCount > 0 && <ul className="flex flex-col">{rows.map((phases, index) => row(phases, `${item.label}の${index + 1}番目の設定`, null, true, 'border-t'))}</ul>}
      {item.addLabel !== null && (
        <div className="border-t p-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onAdd}>
            <Plus aria-hidden="true" />
            {item.addLabel}
          </Button>
        </div>
      )}
    </li>
  )
}

interface TriggerGroupProps {
  group: (typeof menuGroups)[number]
  /** 畳んでいるか。使わない区分を閉じておけるようにする */
  collapsed: boolean
  onToggle(): void
  children: React.ReactNode
}

/**
 * 区分1つぶん。
 *
 * 区分は画面のまとまりとしてカードに入れ、項目の枠はそのカードの中に並べる
 * （区分と項目を同じ字の大きさで並べていたころは、どこまでが1つのまとまりか見分けが付かなかった）。
 * カードは見出しを押して畳める（使わない区分を閉じておけるようにする）。
 */
const TriggerGroup = ({ group, collapsed, onToggle, children }: TriggerGroupProps) => (
  <Card role="region" aria-label={group.label}>
    <CardHeader>
      <CardTitle>
        <Button type="button" variant="ghost" className="-ml-2 h-auto justify-start gap-2 px-2 py-1 text-base font-semibold" aria-expanded={!collapsed} onClick={onToggle}>
          <ChevronDown aria-hidden="true" className={collapsed ? '-rotate-90' : ''} />
          {group.label}
        </Button>
      </CardTitle>
      {/* 説明はボタンの外に出す（読み上げの名前が説明で埋まらないようにする） */}
      {group.description !== null && <CardDescription>{group.description}</CardDescription>}
    </CardHeader>
    {!collapsed && (
      <CardContent>
        <ul className="flex flex-col gap-3">{children}</ul>
      </CardContent>
    )}
  </Card>
)

type Loaded = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; message: string }

/** botの接続状態の読み出し。loaded で bot が null なら未接続 */
type BotConnection = { status: 'checking' } | { status: 'loaded'; bot: BotStatus | null } | { status: 'failed'; message: string }

export interface TriggerPageProps {
  api: AdminApi
  /** botの接続状態の読み出し。未接続ならチャットとアナウンスの動作が動かないので、画面で知らせる */
  botApi: Pick<BotApi, 'status'>
  /** ログイン中の配信者のオーバーレイ用キー。発行されていなければ null */
  overlayKey: string | null
  /** キーを再発行した。アプリの枠が持つログイン情報を新しいキーに書き換えてもらう */
  onOverlayKeyChange(overlayKey: string): void
}

export const TriggerPage = ({ api, botApi, overlayKey, onOverlayKeyChange }: TriggerPageProps) => {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [media, setMedia] = useState<readonly MediaItem[]>([])
  const [rewards, setRewards] = useState<readonly Reward[]>([])
  const [drafts, setDrafts] = useState<readonly TriggerDraft[]>([])
  // 入力欄を開いているトリガーの位置（0始まり）。項目が多いので、開くのは1件ずつにする
  const [openPosition, setOpenPosition] = useState<number | null>(null)
  // 報酬の一覧を取得できなかった理由。操作の失敗（failure）と分けて持ち、ほかの操作が成功しても消さない
  const [rewardsFailure, setRewardsFailure] = useState('')
  // 畳んでいる区分の名前。使わない区分を閉じておけるようにする（既定はすべて開く）
  const [collapsedGroups, setCollapsedGroups] = useState<readonly string[]>([])
  // 最後に保存した（または読み込んだ）入力欄の中身。今の中身と食い違えば、未保存の変更があると知らせる
  const [savedSignature, setSavedSignature] = useState('')
  // botの接続状態。取得できていないあいだと、取得に失敗したときは知らせを出さない（未接続と取り違えないため）
  const [bot, setBot] = useState<BotConnection>({ status: 'checking' })
  // 保存したときに送った項目の名前。Workerが返す問題点の位置を読み替えるのに使う
  const submittedLabelsRef = useRef<readonly string[]>([])
  const actions = usePageActions((error) => failureLines(error, submittedLabelsRef.current))
  // 保存を待つ間に入力欄が書き換えられたかを、保存の応答が届いた時点で確かめるために持つ
  const draftsRef = useRef(drafts)
  const urlFieldId = useId()
  const sizeHintId = useId()

  const replaceDrafts = (next: readonly TriggerDraft[]): void => {
    draftsRef.current = next
    setDrafts(next)
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([api.media(), api.config()]).then(
      ([loadedMedia, triggers]) => {
        if (cancelled) return
        setMedia(loadedMedia)
        const loadedDrafts = withFixedRows(triggers.map(toDraft))
        draftsRef.current = loadedDrafts
        setDrafts(loadedDrafts)
        setSavedSignature(JSON.stringify(loadedDrafts))
        setLoaded({ status: 'ready' })
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: 'failed', message: errorMessage(error) })
      },
    )
    // 報酬の一覧はTwitchに問い合わせるので、素材や保存済みの設定より失敗しやすい（チャンネルポイントを使えないチャンネルなど）。
    // 失敗しても素材の管理は続けられるよう画面は出し、理由を表示する。報酬を選べない間も、報酬の条件を付けなければトリガーは作れる
    api.rewards().then(
      (loadedRewards) => {
        if (!cancelled) setRewards(loadedRewards)
      },
      (error: unknown) => {
        if (!cancelled) setRewardsFailure(`チャンネルポイント報酬の一覧を取得できませんでした: ${errorMessage(error)}`)
      },
    )
    // botの接続状態も、報酬と同じく取得できなくても操作盤は出す。
    // 取得できなかったときは未接続扱いにせず理由を出す（接続済みのbotを未接続に見せてしまわないため）
    botApi.status().then(
      (status) => {
        if (!cancelled) setBot({ status: 'loaded', bot: status })
      },
      (error: unknown) => {
        if (!cancelled) setBot({ status: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, botApi])

  if (overlayKey === null) {
    return (
      <Alert variant="destructive">
        <AlertTitle>トリガーを表示できません</AlertTitle>
        <AlertDescription>オーバーレイ用キーが発行されていません。ログアウトしてログインし直してください</AlertDescription>
      </Alert>
    )
  }
  if (loaded.status === 'loading') return <Skeleton className="h-64 w-full" aria-label="トリガーの設定を読み込んでいます" />
  if (loaded.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertTitle>読み込みに失敗しました</AlertTitle>
        <AlertDescription>トリガーを表示できません: {loaded.message}</AlertDescription>
      </Alert>
    )
  }

  const url = overlayUrl(window.location.origin, overlayKey)
  // 足した設定も書き換えた値も、保存するまで反映されない。読み込んだ（保存した）時点の中身と比べて知らせる
  const unsaved = JSON.stringify(drafts) !== savedSignature

  const copyUrl = async (): Promise<string> => {
    // Clipboard API は https か localhost でしか提供されず、それ以外では navigator.clipboard が undefined になる
    if (!navigator.clipboard) throw new Error('このページではクリップボードを使えません（https か localhost で開いてください）')
    await navigator.clipboard.writeText(url)
    return 'OBS用のURLをコピーしました'
  }

  const rotateKey = async (): Promise<string> => {
    onOverlayKeyChange(await api.rotateOverlayKey())
    return 'キーを再発行しました。新しいURLをOBSに貼り替えてください'
  }

  /** その項目の行（一覧の並びのままの位置付き）。位置は開閉と書き換えの目印に使う */
  const rowsOf = (kind: TriggerKind): { position: number; draft: TriggerDraft }[] =>
    drafts.flatMap((draft, position) => (draft.kind === kind ? [{ position, draft }] : []))

  const togglePosition = (position: number): void => setOpenPosition(openPosition === position ? null : position)

  const changeDraft = (position: number, next: TriggerDraft): void =>
    replaceDrafts(drafts.map((other, index) => (index === position ? next : other)))

  const removeDraft = (position: number): void => {
    // 外した行より後ろは1つ前へ詰まるので、開いている位置もずらす（別の行が開いて見えないようにする）
    setOpenPosition(openPosition === null || openPosition === position ? null : openPosition > position ? openPosition - 1 : openPosition)
    replaceDrafts(drafts.filter((_, index) => index !== position))
  }

  /**
   * 複数持てる項目に設定を1つ足す。
   *
   * 並びは一覧のとおりにそろえるので、足した行は同じ項目の最後に入る。開くのはその行である。
   */
  const addRow = async (kind: TriggerKind): Promise<string> => {
    const next = withFixedRows([...drafts, createDraft(kind, media)])
    replaceDrafts(next)
    // 足した行は同じ項目の最後に入る（findLastIndex は tsconfig の lib に無いので、後ろから探す）
    setOpenPosition(next.map((draft) => draft.kind).lastIndexOf(kind))
    return `「${menuLabel(kind)}」の設定を足しました。保存するまで反映されません`
  }

  const saveTriggers = async (): Promise<string> => {
    const inputs = toTriggerInputs(drafts)
    // Workerが問題点に付ける位置（triggers[0] など）を、送った順の項目の名前へ読み替えるために覚えておく
    submittedLabelsRef.current = drafts.filter(hasAnyAction).map((draft) => menuLabel(draft.kind))
    const submitted = drafts
    const saved = await api.saveConfig(inputs)
    const savedDrafts = withFixedRows(saved.map(toDraft))
    // 未保存かどうかを比べる基準は、書き換えの有無にかかわらずWorkerが保存した内容に進める。
    // 読み込んだ時点のままにすると、保存中の書き換えを元に戻したときに「未保存の変更なし」と見えてしまう
    setSavedSignature(JSON.stringify(savedDrafts))
    // 保存を待つ間に入力欄が書き換えられていたら、その内容を応答で上書きしない（書き換えた分は次の保存で送られる）
    if (draftsRef.current !== submitted) return 'トリガーを保存しました。保存中に書き換えた内容はまだ保存されていません'
    replaceDrafts(savedDrafts)
    return 'トリガーを保存しました'
  }

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      {actions.feedback}
      {bot.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTitle>botの接続状態が分かりません</AlertTitle>
          <AlertDescription>{bot.message}</AlertDescription>
        </Alert>
      )}
      {bot.status === 'loaded' && bot.bot === null && (
        <Alert variant="destructive">
          <AlertTitle>botが接続されていません</AlertTitle>
          <AlertDescription>
            <span>チャットの出来事と、チャット・アナウンスを送る効果が動きません（アラートは動きます）。</span>
            <span>
              <Link href="/bot/" className="underline underline-offset-4">
                チャットボット
              </Link>
              のページで接続してください。
            </span>
          </AlertDescription>
        </Alert>
      )}
      {rewardsFailure !== '' && (
        <Alert variant="destructive">
          <AlertTitle>報酬を選べません</AlertTitle>
          <AlertDescription>{rewardsFailure}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>OBS用のURL</CardTitle>
          <CardDescription>背景は透過で、素材は中央に表示される。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Label htmlFor={urlFieldId}>OBSのブラウザソースに貼るURL</Label>
          <p id={sizeHintId} className="text-sm text-muted-foreground">
            推奨の大きさ: {OVERLAY_SIZE.width} × {OVERLAY_SIZE.height} px（配信のキャンバスと同じ大きさ）
          </p>
          <div className="flex gap-2">
            {/* URLにはオーバーレイ用キーが含まれる。配信画面に映り込んでも読めないよう、伏せ字で表示する */}
            <Input id={urlFieldId} type="password" readOnly autoComplete="off" value={url} aria-describedby={sizeHintId} />
            <Button type="button" disabled={actions.busy} onClick={() => void actions.run(copyUrl)}>
              URLをコピー
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">URLが他人に知られたら、キーを再発行してください。</p>
          <Button
            type="button"
            variant="outline"
            className="self-start text-destructive"
            disabled={actions.busy}
            onClick={() =>
              actions.ask({
                title: 'キーを再発行しますか？',
                description: '今のURLは使えなくなるので、OBSのURLを貼り替える必要があります（反映に最大1分かかります）。',
                actionLabel: '再発行する',
                run: rotateKey,
              })
            }
          >
            キーを再発行する
          </Button>
        </CardContent>
      </Card>

      {/* 一覧そのものはカードに入れず、区分（チャット・イベント）ごとにカードにする
          （全体を1枚のカードで囲むと、その中に区分の見出しと項目の枠が入れ子で並び、どこまでが1つのまとまりか読み取りにくい） */}
      <section className="flex flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-lg font-semibold">トリガー</h2>
          <p className="text-sm text-muted-foreground">
            効果を付けたい出来事を開いて、何をするかを決める。当てはまった出来事の効果はすべて行われる。
          </p>
        </div>
          {media.length === 0 && (
            <p className="text-sm text-muted-foreground">
              素材が1つもないので、アラートを出す効果は選べません。
              <Link href="/media/" className="underline underline-offset-4">
                アップロード
              </Link>
              のページで足してください。
            </p>
          )}
          {menuGroups.map((group) => (
            <TriggerGroup
              key={group.label}
              group={group}
              collapsed={collapsedGroups.includes(group.label)}
              onToggle={() =>
                setCollapsedGroups(collapsedGroups.includes(group.label) ? collapsedGroups.filter((label) => label !== group.label) : [...collapsedGroups, group.label])
              }
            >
              {group.items.map((item) => (
                <TriggerItem
                  key={item.kind}
                  item={item}
                  rowsByPhase={item.phases.map((phase) => rowsOf(phase.kind))}
                  media={media}
                  rewards={rewards}
                  openPosition={openPosition}
                  busy={actions.busy}
                  onToggle={togglePosition}
                  onChange={changeDraft}
                  onRemove={removeDraft}
                  onAdd={() => void actions.run(() => addRow(item.kind))}
                />
              ))}
            </TriggerGroup>
          ))}
        {/* 一覧が長いので、保存ボタンは下に貼り付けておく（一番下まで送らないと保存できない状態を避ける） */}
        <div className="sticky bottom-0 flex items-center gap-3 border-t bg-background py-3">
          <Button type="button" disabled={actions.busy} onClick={() => void actions.run(saveTriggers)}>
            トリガーを保存
          </Button>
          {unsaved && <span className="text-sm text-muted-foreground">未保存の変更があります</span>}
        </div>
      </section>

    </div>
  )
}
