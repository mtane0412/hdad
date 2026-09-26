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
  rowSummary,
  toDraft,
  toTriggerInputs,
  withFixedRows,
  type MenuItem,
  type SelectOption,
  type TriggerDraft,
} from './form'
import { errorMessage, usePageActions } from './page-actions'

/** 文言欄の入力例。メニュー項目ごとに、使える差し込み語だけを使った例を出す */
const MESSAGE_PLACEHOLDERS: Readonly<Record<TriggerKind, string>> = {
  chat: '{user} さんが「{message}」と言いました',
  firstChatEver: '{user} さん、はじめまして！',
  firstChatOfStream: '{user} さん、おかえりなさい！',
  returningAfter: '{user} さん、お久しぶりです！',
  chatFromUser: '{user} さんが来ました',
  chatContains: '{user} さんが「{message}」と言いました',
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

/** メニュー項目に添える注意書き。一覧の項目の見出しの下に出す */
const KIND_NOTES: Partial<Readonly<Record<TriggerKind, string>>> = {
  chat: 'チャットに書き込みがあるたびに動きます。チャットの多い配信では、アラートや音を出す効果は控えめにしてください。',
  firstChatOfStream: '配信中の発言だけが対象です。配信していないあいだの発言では動きません（テスト配信のたびに動かないようにするため）。',
  firstChatEver:
    '視聴者の記録が残っていない人だけが対象です。この記録を始める前から来ている常連も「初めて」と扱われるので、しばらくは効果を控えめにしておくことをおすすめします。',
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

    {draft.kind === 'chatFromUser' && (
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
        <p className="text-xs text-muted-foreground">Twitchのユーザー名（表示名ではなく小文字のほう）で指定します。大文字小文字は区別しません。</p>
      </div>
    )}

    {draft.kind === 'chatContains' && (
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
        <p className="text-xs text-muted-foreground">この言葉を含む発言が対象です（部分一致。大文字小文字は区別しません）。</p>
      </div>
    )}

    {draft.kind === 'returningAfter' && (
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
        <p className="text-xs text-muted-foreground">
          この日数以上空けて発言した人だけが対象です（{MIN_RETURNING_DAYS}〜{MAX_RETURNING_DAYS}日）。
          このチャンネルで初めての人には当てはまりません。
        </p>
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

interface TriggerRowProps {
  /** 行の呼び名（読み上げと操作の目印）。項目が1行だけなら項目の名前、複数持てる項目なら何番目の設定か */
  label: string
  /** 見出しに出す項目の名前。複数持てる項目では項目の見出しが別にあるので渡さない */
  heading: string | null
  /** 見出しの下に出す注意書き。無ければ null（開かなくても読めるように、折りたたみの外に出す） */
  note: string | null
  draft: TriggerDraft
  media: readonly MediaItem[]
  rewards: readonly Reward[]
  /** 入力欄を開いているか。開くのは1件ずつなので、どれを開くかは一覧を持つページが決める */
  open: boolean
  onToggle(): void
  onChange(draft: TriggerDraft): void
  /** その行を外す。外せない行（複数持てない項目の行）では null。効果をすべて外せば何も起きない */
  onRemove: (() => void) | null
}

/**
 * トリガー1行ぶんの操作盤。
 *
 * 項目が多いので、ふだんは要約だけを見出しに出して折りたたみ、見出しを押したときだけ入力欄を開く。
 * 効果をひとつも持たない行は保存されないので、要約には「効果なし」と出す。
 */
const TriggerRow = ({ label, heading, note, draft, media, rewards, open, onToggle, onChange, onRemove }: TriggerRowProps) => {
  const id = useId()
  const update = (patch: Partial<TriggerDraft>): void => onChange({ ...draft, ...patch })
  const mediaOptions = media.map((item) => ({ value: item.id, label: `${item.name}（${kindLabels[item.kind]}）` }))

  return (
    <li aria-label={label} className="rounded-lg border">
      <div className="flex items-center gap-1 p-2">
        <Button
          type="button"
          variant="ghost"
          className="min-w-0 flex-1 justify-start gap-2 font-normal"
          aria-expanded={open}
          aria-controls={`${id}-detail`}
          onClick={onToggle}
        >
          <ChevronDown aria-hidden="true" className={open ? 'rotate-180' : ''} />
          {heading === null ? <span className="sr-only">{label}:</span> : <span className="truncate">{heading}</span>}
          <span className="truncate text-muted-foreground">{rowSummary(draft, rewards)}</span>
        </Button>
        {onRemove !== null && (
          <Button type="button" variant="ghost" size="icon" aria-label={`${label}を外す`} className="text-destructive" onClick={onRemove}>
            <Trash2 aria-hidden="true" />
          </Button>
        )}
      </div>
      {note !== null && <p className="px-3 pb-2 text-xs text-muted-foreground">{note}</p>}
      {open && (
        <div id={`${id}-detail`} className="grid gap-4 border-t p-4 sm:grid-cols-2">
          {/* きっかけは一覧の項目そのものなので、ここで出すのは絞り込みのパラメータだけである */}
          <TriggerParamField idPrefix={id} draft={draft} rewards={rewards} onChange={update} />

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
                <p className="text-xs text-muted-foreground">接続しているbotアカウントが送ります（チャットボットのページで接続します）。</p>
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
                  接続しているbotアカウントが送ります。文面はそのつどAIが書くので、差し込み語は要りません。
                  相手の名前・発言の本文と、視聴者の記録（メモ・来訪の履歴）を材料に渡します。
                </p>
                <p className="text-xs text-muted-foreground">
                  「チャットに送る」とは同時に選べません（同じ発言に2通返ってしまうため）。
                  AIが作った文面が500文字を超えたときや、AIが失敗したときは送らず、配信の記録の「収集の失敗」に残します。
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
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  接続しているbotアカウントが、モデレーターとして送ります（チャットボットのページで接続し、配信者がモデレーター権限を与えてください）。
                </p>
              </div>
            )}
          </div>

          {/* 選んだメニュー項目のイベントに存在しない語は置き換わらないため、使える語をその場で知らせる（アラートとチャットで同じ語を使う） */}
          <p className="text-xs text-muted-foreground sm:col-span-2">
            このトリガーで使える差し込み語: {placeholdersFor(draft.kind).join('・')}
          </p>
        </div>
      )}
    </li>
  )
}

/** 行1つを画面のどこで開いているかを表す位置（drafts の添字） */
interface TriggerItemProps {
  item: MenuItem
  /** この項目の行（drafts の添字と入力欄の値の組。位置は開閉と書き換えに使う） */
  rows: readonly { position: number; draft: TriggerDraft }[]
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
 * 絞り込みのパラメータを持たない項目はちょうど1行で、その行の見出しが項目の見出しを兼ねる
 * （見出しを2段重ねると、1行しかない項目でも入れ子があるように見えてしまう）。
 * パラメータを持つ項目は、配信者が足したぶんだけ行が並ぶ（報酬ごとに違う効果を付けられるようにするため）。
 */
const TriggerItem = ({ item, rows, media, rewards, openPosition, busy, onToggle, onChange, onRemove, onAdd }: TriggerItemProps) => {
  const row = (position: number, draft: TriggerDraft, label: string, heading: string | null) => (
    <TriggerRow
      key={position}
      label={label}
      heading={heading}
      note={KIND_NOTES[item.kind] ?? null}
      draft={draft}
      media={media}
      rewards={rewards}
      open={openPosition === position}
      onToggle={() => onToggle(position)}
      onChange={(next) => onChange(position, next)}
      // パラメータを持たない項目の行は外せない（効果をすべて外せば何も起きない）
      onRemove={item.multiple ? () => onRemove(position) : null}
    />
  )

  // パラメータを持たない項目は withFixedRows が必ず1行を用意するので、行が無いことはない
  if (!item.multiple) {
    const only = rows[0]
    return only === undefined ? null : row(only.position, only.draft, item.label, item.label)
  }

  return (
    <li className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{item.label}</span>
        <span className="text-xs text-muted-foreground">{item.description}</span>
      </div>
      {rows.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rows.map(({ position, draft }, index) => row(position, draft, `${item.label}の${index + 1}番目の設定`, null))}
        </ul>
      )}
      <Button type="button" variant="outline" size="sm" className="self-start" disabled={busy} onClick={onAdd}>
        <Plus aria-hidden="true" />
        {item.addLabel}
      </Button>
    </li>
  )
}

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
    // 保存を待つ間に入力欄が書き換えられていたら、その内容を応答で上書きしない（書き換えた分は次の保存で送られる）
    if (draftsRef.current !== submitted) return 'トリガーを保存しました。保存中に書き換えた内容はまだ保存されていません'
    replaceDrafts(withFixedRows(saved.map(toDraft)))
    return 'トリガーを保存しました。次の出来事から反映されます'
  }

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        配信で起きる出来事を選び、そのときに何をするかを決める。
      </p>

      {actions.feedback}
      {bot.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTitle>botの接続状態が分かりません</AlertTitle>
          <AlertDescription>botの接続状態を取得できませんでした: {bot.message}</AlertDescription>
        </Alert>
      )}
      {bot.status === 'loaded' && bot.bot === null && (
        <Alert variant="destructive">
          <AlertTitle>botが接続されていません</AlertTitle>
          <AlertDescription>
            <span>
              「チャットに送る」「AIに文面を作らせて送る」「アナウンスを送る」の動作は、接続しているbotアカウントが送るので動きません。とくに「チャットの発言」のトリガーは、
              発言を受け取るのにbotのユーザーIDが要るため、Workerに発言そのものが届きません（アラートを出す動作はオーバーレイが受け取るので動きます）。
            </span>
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
          <AlertDescription>{rewardsFailure}（報酬の条件を付けなければトリガーは作れます）</AlertDescription>
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
            推奨の大きさ: 幅 {OVERLAY_SIZE.width} × 高さ {OVERLAY_SIZE.height} px（配信のキャンバスと同じ大きさ）
          </p>
          <div className="flex gap-2">
            {/* URLにはオーバーレイ用キーが含まれる。配信画面に映り込んでも読めないよう、伏せ字で表示する */}
            <Input id={urlFieldId} type="password" readOnly autoComplete="off" value={url} aria-describedby={sizeHintId} />
            <Button type="button" disabled={actions.busy} onClick={() => void actions.run(copyUrl)}>
              URLをコピー
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            URLが他人に知られたら、キーを再発行してください。再発行すると今のURLは使えなくなり、OBSのURLを貼り替える必要があります（反映に最大1分かかります）。
          </p>
          <Button
            type="button"
            variant="outline"
            className="self-start text-destructive"
            disabled={actions.busy}
            onClick={() =>
              actions.ask({
                title: 'キーを再発行しますか？',
                description: 'キーを再発行すると、今のURLは使えなくなります。OBSのURLを貼り替える必要があります。',
                actionLabel: '再発行する',
                run: rotateKey,
              })
            }
          >
            キーを再発行する
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>トリガー</CardTitle>
          <CardDescription>
            配信で起きる出来事が並んでいる。効果を付けたい出来事を開いて、何をするかを決める。
            出来事が起きたら、当てはまった行の効果をすべて行う。効果をひとつも付けていない行では何も起きない。
            文言の <code>{'{user}'}</code> は相手の名前に、<code>{'{summary}'}</code> は配信の「これまでのあらすじ」に置き換わる。
            ほかに使える差し込み語は出来事ごとに違い、それぞれの文言欄の下に出る。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {media.length === 0 && (
            <p className="text-sm text-muted-foreground">
              素材が1つもないので、アラートを出す効果は選べません。
              <Link href="/media/" className="underline underline-offset-4">
                アップロード
              </Link>
              のページで素材を足してください。
            </p>
          )}
          {menuGroups.map((group) => (
            <section key={group.label} aria-label={group.label} className="flex flex-col gap-3">
              <h3 className="text-sm font-medium">{group.label}</h3>
              <ul className="flex flex-col gap-3">
                {group.items.map((item) => (
                  <TriggerItem
                    key={item.kind}
                    item={item}
                    rows={rowsOf(item.kind)}
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
              </ul>
            </section>
          ))}
          <Button type="button" className="self-start" disabled={actions.busy} onClick={() => void actions.run(saveTriggers)}>
            トリガーを保存
          </Button>
        </CardContent>
      </Card>

    </div>
  )
}
