/**
 * コメントビューアーのページ（/comments/）
 *
 * 配信中に配信者が横に開いておくための画面で、チャットの発言と、サブスク・ギフト・レイド・ビッツ・
 * チャンネルポイントの引き換え・フォローといった出来事を、届いた順に1本の流れとして並べる。
 * 発言はアイコン・バッジ・名前（本人が決めた色）・本文（エモートは画像）で出し、出来事は1行の文にして目立たせる。
 *
 * 受け取りは配送先（worker/comment-channel.ts）への WebSocket（socket.ts）で、つないだ直後に直近の履歴が届くので、
 * 画面を開き直しても直前の流れが見える。並べ方の決まり（二重に並べない・消された発言に印を付ける）は feed.ts が持つ。
 * アイコンは初めて見た人のぶんだけをまとめて問い合わせる（api.ts）。
 *
 * 発言の行のボタンから、その発言を注目コメント（配信画面に大きく映す1件）に設定できる。保存は Worker の
 * 経路（src/focus/api.ts の save）で行い、取り上げている発言には印を付ける。いま取り上げている1件は流れの上にも出し、
 * そこからやめられる（開く前に取り上げた発言は流れに無いことがあるため）。注目コメント専用のページは持たない。
 * モデレーターに消された発言は取り上げられない（配信画面に出さないため）。
 *
 * 発言の行のボタンから、モデレーターの操作（発言の削除・タイムアウト・BAN）もできる。どれも botの権限で行われ
 * （api.ts の moderate）、BANだけは取り返しが重いので確かめてから行う。処分された発言には、Twitch から届く
 * 削除・消去の通知で印が付く（画面が自分で印を付けない）。
 *
 * 流れの下の入力欄から、配信者本人としてチャットを送れる（api.ts の send）。送った発言は、ほかの発言と同じく
 * Twitch から届いた時点で流れに並ぶ（画面が先回りして並べない）。Enter で送るが、日本語入力の変換を確定する
 * Enter（isComposing）では送らない。
 *
 * その配信で初めての発言（Worker が判定して firstOfStream を付ける）には「初コメ」の印と挨拶のボタンを置き、
 * 配信者が挨拶したら押す（もう一度押すと戻す。api.ts の markGreeted）。挨拶の印は、ほかの1件と同じく配送先から
 * 届いた付け替えで付く（画面が先回りして付けない）。まだ挨拶していない初めての発言（feed.ts の needsGreeting）は
 * 「未挨拶」として目立たせ、流れの上に名前を一覧にする。名前を押すとその発言の行へ移る（挨拶漏れに気づけるように）。
 * 挨拶したかは配信者だけが決める（発話から自動で判定しない。docs/decisions/comments.md）。
 *
 * 流れは下へ伸びる。いちばん下を見ているあいだは新しい1件に合わせて下へ送り、上へ遡って読んでいるあいだは
 * 送らない（読んでいる行が動かないように）。
 *
 * 注意: 失敗（読み取れない1件・アイコンを引けない・接続が切れた）は黙って無視せず、理由を画面に出す（Fail-Fast）。
 * 読み取れない1件のために流れ全体は止めない（届いた残りは並べ続ける）。
 */
import { ArrowDown, Ban, Gift, Hand, Heart, Megaphone, Quote, Send, Sparkles, Star, Timer, Trash2, Users, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePageActions } from '@/admin/page-actions'
import { badgeKey, type BadgeMap } from '@/chat/badges'
import { twitchEmoteUrl } from '@/chat/message'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { iconButtonName } from '@/core/icon-button'
import type { FocusApi } from '@/focus/api'
import type { FocusTarget } from '@/focus/focused'
import { cn } from '@/lib/utils'
import { describeModeration, pickUnknownUserIds, type CommentApi, type ModerationAction } from './api'
import {
  applyFeedItems,
  describeEvent,
  EMPTY_FEED,
  needsGreeting,
  parseFeedMessage,
  pendingGreetings,
  toFocusPick,
  type ChatItem,
  type EventItem,
  type Feed,
  type FeedBadge,
  type FeedEntry,
  type FeedFragment,
  type FeedUser,
} from './feed'
import type { CommentFeedConnection, CommentFeedHandlers } from './socket'

/** 日本語入力の変換を処理しているあいだの keydown に付く keyCode */
const IME_PROCESSING_KEY_CODE = 229

/** いちばん下を見ているとみなす、下端からの距離（画素）。端数の揺れで「遡っている」と取り違えないための遊び */
const FOLLOW_THRESHOLD_PX = 32

/** 並びの1行に振る要素のID。上部の一覧から、その行へ移るのに使う */
const rowElementId = (item: ChatItem): string => `comment-row-${item.id}`

export interface CommentsPageProps {
  api: CommentApi
  /** 注目コメントの読み書き */
  focusApi: FocusApi
  /** 配送先へつなぐ。テストで差し替えるために受け取る（本番は socket.ts の connectCommentFeed） */
  connect(handlers: CommentFeedHandlers): CommentFeedConnection
}

/** 届いた時刻を、配信者のブラウザの時間帯で「時:分」に直す */
const formatTime = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/**
 * 発言した人のアイコン。まだ引けていない・引けなかった人は同じ大きさの丸を置く（行の高さと並びを揃えるため）。
 *
 * 注意: shadcn/ui の Avatar ではなく素の img で出す（配信画面の注目コメントと同じ。読み込むまで img を置かない
 * Avatar では、URLが壊れていても気付けない）。隣の名前と同じ人を指す飾りなので、代替文字は空にする。
 */
const Icon = ({ user, icons }: { user: FeedUser | null; icons: ReadonlyMap<string, string> }) => {
  const url = user === null ? undefined : icons.get(user.id)
  if (url === undefined) return <span aria-hidden="true" className="mt-0.5 size-6 shrink-0 rounded-full bg-muted" />
  return <img src={url} alt="" className="mt-0.5 size-6 shrink-0 rounded-full" />
}

/** 付いているバッジ。画像の表にないもの（まだ読めていない・Twitchが返さなかった）は出さない */
const Badges = ({ badges, badgeImages }: { badges: readonly FeedBadge[]; badgeImages: BadgeMap }) => (
  <>
    {badges.map((badge) => {
      const image = badgeImages.get(badgeKey(badge))
      return image && <img key={badgeKey(badge)} src={image.url} alt={image.title} title={image.title} className="mr-1 inline size-4 align-[-2px]" />
    })}
  </>
)

/** 本文。エモートは画像にし、代替文字にはエモートの名前を入れる（コピーしたときに文として読めるように） */
const Fragments = ({ fragments }: { fragments: readonly FeedFragment[] }) => (
  <>
    {fragments.map((fragment, index) =>
      fragment.emoteId === null ? (
        <span key={index}>{fragment.text}</span>
      ) : (
        <img key={index} src={twitchEmoteUrl(fragment.emoteId)} alt={fragment.text} title={fragment.text} className="inline h-6 align-middle" />
      ),
    )}
  </>
)

/** 名前。本人が決めた色で出す（決めていない人は文字色のまま） */
const Name = ({ user, color }: { user: FeedUser; color: string | null }) => (
  <span className="font-semibold" style={color === null ? undefined : { color }}>
    {user.name}
  </span>
)

/** 発言の行が受け取る操作（挨拶・注目コメント・モデレーター） */
interface RowControls {
  /** 挨拶したか（その配信で初めての発言にだけ意味を持つ） */
  greeted: boolean
  /** まだ挨拶していないので目立たせるか */
  awaitingGreeting: boolean
  /** 挨拶した・挨拶していない状態に戻す */
  onToggleGreeting(): void
  /** この発言を注目コメントとして取り上げているか */
  focused: boolean
  /** 操作の途中か（二重に押させない） */
  busy: boolean
  /** この発言の削除をすでに頼み、成功したか（Twitch から消えた知らせが届くまで、もう一度削除させない） */
  deleteRequested: boolean
  /** 取り上げる・取り上げをやめる */
  onToggleFocus(): void
  /** 処分する（BANは確かめてから） */
  onModerate(action: ModerationAction): void
}

/** 行の端に置く、アイコンだけの操作のボタン。押された状態を持たないものは、行に触れるまで薄くしておく */
const rowButtonClass = 'shrink-0 opacity-40 group-hover:opacity-100 focus-visible:opacity-100'

const ChatRow = ({
  item,
  removed,
  icons,
  badgeImages,
  controls,
}: {
  item: ChatItem
  removed: boolean
  icons: ReadonlyMap<string, string>
  badgeImages: BadgeMap
  controls: RowControls
}) => (
  <div
    className={cn(
      'group flex items-start gap-2 border-l-4 border-transparent px-3 py-1.5',
      controls.focused && 'bg-accent',
      controls.awaitingGreeting && 'border-amber-500 bg-amber-500/10',
    )}
  >
    {/* 消された発言はアイコンと本文を薄くするが、操作のボタンは薄くしない（その人のタイムアウト・BANは続けてできる） */}
    <div className={cn('flex min-w-0 flex-1 items-start gap-2', removed && 'opacity-50')}>
      <Icon user={item.user} icons={icons} />
      <div className="min-w-0 flex-1 text-sm break-words">
        {item.reply && (
          <p className="truncate text-xs text-muted-foreground">
            {item.reply.name} さんへの返信: {item.reply.text}
          </p>
        )}
        <time className="mr-2 text-xs text-muted-foreground tabular-nums">{formatTime(item.at)}</time>
        <Badges badges={item.badges} badgeImages={badgeImages} />
        <Name user={item.user} color={item.color} />
        <span className="text-muted-foreground">: </span>
        <span className={cn(removed && 'line-through')}>
          <Fragments fragments={item.fragments} />
        </span>
        {item.bits !== null && <span className="ml-2 rounded bg-primary/10 px-1.5 text-xs font-semibold text-primary">{item.bits} ビッツ</span>}
        {removed && <span className="ml-2 text-xs text-muted-foreground">（削除済み）</span>}
        {controls.focused && <span className="ml-2 rounded bg-primary px-1.5 text-xs font-semibold text-primary-foreground">注目中</span>}
        {/* 色だけに頼らず、文字でも挨拶がまだであることを出す */}
        {controls.awaitingGreeting && <span className="ml-2 rounded bg-amber-500 px-1.5 text-xs font-semibold text-white">未挨拶</span>}
        {item.firstOfStream && !controls.awaitingGreeting && <span className="ml-2 text-xs text-muted-foreground">初コメ</span>}
      </div>
    </div>
    <div className="flex shrink-0 gap-0.5">
      {item.firstOfStream && (
        // 押された状態（aria-pressed）で「挨拶した」を表し、もう一度押すと戻す。挨拶がまだなら目立たせるので薄くしない
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          {...iconButtonName('この人に挨拶した')}
          aria-pressed={controls.greeted}
          disabled={controls.busy}
          onClick={controls.onToggleGreeting}
          className={cn('shrink-0', controls.greeted && 'text-primary')}
        >
          <Hand aria-hidden="true" />
        </Button>
      )}
      {/* 押された状態（aria-pressed）で「取り上げている」を表し、もう一度押すとやめる */}
      <Button
        type="button"
        variant={controls.focused ? 'default' : 'ghost'}
        size="icon-sm"
        {...iconButtonName('この発言を注目コメントにする')}
        aria-pressed={controls.focused}
        // 消された発言は取り上げさせない。ただし取り上げたあとで消されたものは、やめられるように押せるままにする
        disabled={controls.busy || (removed && !controls.focused)}
        onClick={controls.onToggleFocus}
        className={cn('shrink-0', !controls.focused && rowButtonClass)}
      >
        <Quote aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        {...iconButtonName('この発言を削除')}
        disabled={controls.busy || removed || controls.deleteRequested}
        onClick={() => controls.onModerate('delete')}
        className={rowButtonClass}
      >
        <Trash2 aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        {...iconButtonName('この人をタイムアウト')}
        disabled={controls.busy}
        onClick={() => controls.onModerate('timeout')}
        className={rowButtonClass}
      >
        <Timer aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        {...iconButtonName('この人をBAN')}
        disabled={controls.busy}
        onClick={() => controls.onModerate('ban')}
        className={cn(rowButtonClass, 'text-destructive')}
      >
        <Ban aria-hidden="true" />
      </Button>
    </div>
  </div>
)

/** 出来事の種類ごとの目印 */
const eventIcon = (item: EventItem): LucideIcon => {
  switch (item.kind) {
    case 'follow':
      return Heart
    case 'redemption':
      return Sparkles
    case 'notice':
      switch (item.notice.type) {
        case 'subGift':
        case 'communityGift':
          return Gift
        case 'raid':
          return Users
        case 'announcement':
          return Megaphone
        default:
          return Star
      }
  }
}

/** 出来事の行。発言の流れの中で見落とさないよう、色の付いた帯にする */
const EventRow = ({ item, removed, icons }: { item: EventItem; removed: boolean; icons: ReadonlyMap<string, string> }) => {
  const Mark = eventIcon(item)
  return (
    <div className={cn('flex items-start gap-2 border-l-4 border-primary bg-primary/5 px-3 py-2', removed && 'opacity-50')}>
      <Icon user={item.user} icons={icons} />
      <div className="min-w-0 flex-1 text-sm break-words">
        <p className="font-semibold">
          <Mark aria-hidden="true" className="mr-1 inline size-4 align-[-3px] text-primary" />
          <time className="mr-2 text-xs font-normal text-muted-foreground tabular-nums">{formatTime(item.at)}</time>
          {describeEvent(item)}
        </p>
        {item.kind === 'notice' && item.fragments.length > 0 && (
          <p className={cn(removed && 'line-through')}>
            <Fragments fragments={item.fragments} />
          </p>
        )}
        {item.kind === 'redemption' && item.input !== '' && <p>{item.input}</p>}
        {removed && <p className="text-xs text-muted-foreground">（削除済み）</p>}
      </div>
    </div>
  )
}

const Row = ({
  entry,
  icons,
  badgeImages,
  controls,
}: {
  entry: FeedEntry
  icons: ReadonlyMap<string, string>
  badgeImages: BadgeMap
  controls: (item: ChatItem) => RowControls
}) =>
  entry.item.kind === 'chat' ? (
    <ChatRow item={entry.item} removed={entry.removed} icons={icons} badgeImages={badgeImages} controls={controls(entry.item)} />
  ) : (
    <EventRow item={entry.item} removed={entry.removed} icons={icons} />
  )

export const CommentsPage = ({ api, focusApi, connect }: CommentsPageProps) => {
  const [feed, setFeed] = useState<Feed>(EMPTY_FEED)
  const [icons, setIcons] = useState<ReadonlyMap<string, string>>(new Map())
  const [badgeImages, setBadgeImages] = useState<BadgeMap>(new Map())
  /** 直近の失敗。次の失敗で上書きする（配信中に積み上がって流れを押し下げないように） */
  const [problem, setProblem] = useState<string | null>(null)
  /** 接続の状態のお知らせ。つながっていれば null */
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null)
  /** 注目コメントとして取り上げている1件。取り上げていなければ null */
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null)
  const focusedMessageId = focusTarget?.messageId ?? null
  /**
   * 取り上げているものを読めたか。読み込み中・読めなかったときに「何も取り上げていない」と書かないために持つ
   * （この画面で取り上げ直した・やめたあとは、その結果を読めたものとして扱う）
   */
  const [focusLoad, setFocusLoad] = useState<'loading' | 'loaded' | 'failed'>('loading')
  const actions = usePageActions()
  /** 送る文言の入力欄 */
  const [draft, setDraft] = useState('')
  /**
   * 送っている途中か。actions.busy は描き直すまで変わらないので、素早い連打で同じ文言を2度送らないよう
   * 描き直しを待たずに立てる印を別に持つ
   */
  const sending = useRef(false)
  /** 削除に成功した発言のID。Twitch から消えた知らせが届くまでのあいだ、同じ発言をもう一度削除させない */
  const [deleteRequestedChat, setDeleteRequestedChat] = useState<ReadonlySet<string>>(new Set())
  /** この画面で取り上げ直したか。開いたときの読み込みが遅れて返っても、選び直した結果を古い内容で上書きしない */
  const reselected = useRef(false)
  /** いちばん下を見ているか。見ているあいだだけ、新しい1件に合わせて下へ送る */
  const [following, setFollowing] = useState(true)
  /** アイコンを問い合わせた人（Twitchが返さなかった人も含む。同じ人を何度も問い合わせない。問い合わせ自体が失敗した人は外す） */
  const asked = useRef(new Set<string>())
  const scroller = useRef<HTMLDivElement>(null)

  const reportFailure = useCallback((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)), [])

  // 配送先へつなぎ、画面を離れるときに閉じる（閉じないと、行き来するたびに接続が増える）
  useEffect(() => {
    const connection = connect({
      onMessage: (text) => {
        try {
          const message = parseFeedMessage(text)
          setFeed((current) => applyFeedItems(current, message.type === 'backlog' ? message.items : [message.item]))
        } catch (error) {
          // 読めない1件のために流れ全体を止めない。画面に知らせたうえで、原因を追えるよう記録する
          reportFailure(error)
          console.error('コメントビューアーに届いたものを読み取れませんでした', text, error)
        }
      },
      onStatus: (status) => setConnectionNotice(status === 'disconnected' ? '配送先との接続が切れました。つなぎ直しています…' : null),
      onWarning: (message) => setConnectionNotice(message),
    })
    return () => connection.close()
  }, [connect, reportFailure])

  // バッジの画像は開いたときに1度だけ読む（滅多に変わらない）
  useEffect(() => {
    let cancelled = false
    api.loadBadges().then(
      (loaded) => {
        if (!cancelled) setBadgeImages(loaded)
      },
      (error: unknown) => {
        if (!cancelled) reportFailure(error)
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, reportFailure])

  // いま取り上げている注目コメントを、開いたときに1度読む（印を付けるため）
  useEffect(() => {
    let cancelled = false
    focusApi.load().then(
      (target) => {
        if (cancelled || reselected.current) return
        setFocusTarget(target)
        setFocusLoad('loaded')
      },
      (error: unknown) => {
        if (cancelled) return
        reportFailure(error)
        if (!reselected.current) setFocusLoad('failed')
      },
    )
    return () => {
      cancelled = true
    }
  }, [focusApi, reportFailure])

  /**
   * 取り上げている発言（messageId）の取り上げをやめる。
   *
   * やめる前にいま取り上げているものを読み直し、ほかの画面（別のタブで開いたこの画面など）で別の発言に
   * 取り上げ直されていたら、やめずに表示のほうを合わせる（ほかの画面での選択を消さないため）。保存先のKVには
   * 「比べてから書き換える」仕組みがないので、読み直してから保存するまでのわずかな隙間は残る。
   */
  const stopFocus = (messageId: string) =>
    void actions.run(async () => {
      reselected.current = true
      const current = await focusApi.load()
      if (current !== null && current.messageId !== messageId) {
        setFocusTarget(current)
        setFocusLoad('loaded')
        return `注目コメントはほかの画面で別の発言に変わっていたので、やめずに表示を合わせました（いまは ${current.displayName} さんの発言）`
      }
      await focusApi.save(null)
      setFocusTarget(null)
      setFocusLoad('loaded')
      return '注目コメントの取り上げをやめました'
    })

  /** 発言を注目コメントに設定する。すでに取り上げている発言なら、取り上げをやめる */
  const toggleFocus = (item: ChatItem) => {
    if (focusedMessageId === item.messageId) {
      stopFocus(item.messageId)
      return
    }
    void actions.run(async () => {
      reselected.current = true
      setFocusTarget(await focusApi.save(toFocusPick(item)))
      setFocusLoad('loaded')
      return `${item.user.name} さんの発言を注目コメントにしました`
    })
  }

  /** 発言した人（または発言）を処分する。BANは取り返しが重いので確かめてから行う */
  const moderate = (item: ChatItem, action: ModerationAction) => {
    const run = async () => {
      const result = await api.moderate(action, { messageId: item.messageId, userId: item.user.id })
      if (result.action === 'delete') setDeleteRequestedChat((current) => new Set([...current, item.messageId]))
      return describeModeration(result, item.user.name)
    }
    if (action !== 'ban') {
      void actions.run(run)
      return
    }
    actions.ask({
      title: `${item.user.name} さんをBANしますか？`,
      description: 'BANした人はこのチャンネルのチャットに書き込めなくなります。解除は Twitch のモデレーター画面から行います。',
      actionLabel: 'BANする',
      run,
    })
  }

  /** 初めての発言に「挨拶した」を付ける（付いていれば外す）。印は配送先から付け替えが届いた時点で付くので、お知らせは出さない */
  const toggleGreeting = (item: ChatItem, greeted: boolean) =>
    void actions.run(async () => {
      await api.markGreeted(item.messageId, !greeted)
      return ''
    })

  /** 上部の一覧から、その発言の行へ移る。移った先で止まるよう、いちばん下への追従はやめる */
  const jumpTo = (item: ChatItem) => {
    setFollowing(false)
    document.getElementById(rowElementId(item))?.scrollIntoView({ block: 'center' })
  }

  /** 入力欄の文言を、配信者としてチャットへ送る。送れたら入力欄を空にし、送れなければ文言を残す */
  const send = () => {
    if (sending.current) return
    sending.current = true
    void actions.run(async () => {
      try {
        // 送っているあいだに書き足された文言は消さない（送った文言のままのときだけ空にする）
        const message = draft
        await api.send(message)
        setDraft((current) => (current === message ? '' : current))
        // 送った発言は Twitch から届いて流れに並ぶので、お知らせは出さない
        return ''
      } finally {
        // 送れなかったときも外す（外さないと、理由を読んだあとにもう一度送れなくなる）
        sending.current = false
      }
    })
  }

  // 初めて見た人のアイコンを、まとめて問い合わせる。
  // 失敗したら問い合わせた印を外し、次に1件届いたときに問い合わせ直す（一時的な失敗でアイコンが出ないままにしない）
  useEffect(() => {
    const userIds = pickUnknownUserIds(feed.entries, asked.current)
    if (userIds.length === 0) return
    for (const userId of userIds) asked.current.add(userId)
    api.loadIcons(userIds).then(
      (loaded) => setIcons((current) => new Map([...current, ...Object.entries(loaded)])),
      (error: unknown) => {
        for (const userId of userIds) asked.current.delete(userId)
        reportFailure(error)
      },
    )
  }, [feed, api, reportFailure])

  // いちばん下を見ているあいだは、新しい1件に合わせて下へ送る（描き終えた直後に送るので、ちらつかない）
  useLayoutEffect(() => {
    const element = scroller.current
    if (following && element) element.scrollTop = element.scrollHeight
  }, [feed, following])

  // まだ挨拶していない初めての発言（上部の一覧に並べる）
  const waiting = pendingGreetings(feed.entries)

  const checkPosition = () => {
    const element = scroller.current
    if (element) setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_THRESHOLD_PX)
  }

  return (
    <div className="flex flex-col gap-3">
      {actions.feedback}
      {problem !== null && (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      {connectionNotice !== null && <p className="text-sm text-muted-foreground">{connectionNotice}</p>}

      <section aria-label="注目コメント" className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
        {focusLoad === 'loading' ? (
          <p className="text-muted-foreground">注目コメント: いま取り上げているものを読み込んでいます…</p>
        ) : focusLoad === 'failed' ? (
          <p className="text-destructive">注目コメント: いま取り上げているものを読めませんでした（理由は上に出ています）</p>
        ) : focusTarget === null ? (
          <p className="text-muted-foreground">注目コメント: いまは何も取り上げていません（発言の行のボタンで取り上げる）</p>
        ) : (
          <>
            {/* 隣の名前と同じ人を指す飾りなので、代替文字は空にする（素の img にする理由は Icon と同じ） */}
            <img src={focusTarget.profileImageUrl} alt="" className="size-8 shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col">
              <p className="text-xs text-muted-foreground">注目コメント: {focusTarget.displayName} さん</p>
              <p className="truncate">{focusTarget.text}</p>
            </div>
            <Button type="button" variant="outline" size="sm" disabled={actions.busy} onClick={() => stopFocus(focusTarget.messageId)}>
              取り上げをやめる
            </Button>
          </>
        )}
      </section>

      <section aria-label="まだ挨拶していない人" className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
        {waiting.length === 0 ? (
          <p className="text-muted-foreground">まだ挨拶していない初コメはありません</p>
        ) : (
          <>
            <span className="font-semibold">未挨拶 {waiting.length}人:</span>
            {waiting.map((item) => (
              <Button key={item.id} type="button" variant="outline" size="sm" className="border-amber-500" onClick={() => jumpTo(item)}>
                {item.user.name}
              </Button>
            ))}
          </>
        )}
      </section>

      <div className="relative">
        {/* 画面の高さから、本文の見出し・下部バー・余白・上の区画の分を引いた高さにする（上部バーをなくし高さ4remの下部バーを足したとき 12rem から直した。issue #235） */}
        <div ref={scroller} onScroll={checkPosition} className="h-[calc(100dvh-16rem)] min-h-80 overflow-y-auto rounded-md border">
          {feed.entries.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">まだ何も届いていません。チャットの発言や出来事が届くと、ここに並びます。</p>
          ) : (
            <ol aria-label="チャットと出来事" className="flex flex-col py-1">
              {feed.entries.map((entry) => (
                <li key={entry.item.id} id={entry.item.kind === 'chat' ? rowElementId(entry.item) : undefined}>
                  <Row
                    entry={entry}
                    icons={icons}
                    badgeImages={badgeImages}
                    controls={(item) => ({
                      greeted: entry.greeted,
                      awaitingGreeting: needsGreeting(entry),
                      onToggleGreeting: () => toggleGreeting(item, entry.greeted),
                      focused: item.messageId === focusedMessageId,
                      busy: actions.busy,
                      deleteRequested: deleteRequestedChat.has(item.messageId),
                      onToggleFocus: () => toggleFocus(item),
                      onModerate: (action) => moderate(item, action),
                    })}
                  />
                </li>
              ))}
            </ol>
          )}
        </div>
        {!following && (
          <Button type="button" size="sm" className="absolute right-4 bottom-4 shadow" onClick={() => setFollowing(true)}>
            <ArrowDown aria-hidden="true" />
            最新へ
          </Button>
        )}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <Input
          aria-label="チャットに送る文言"
          placeholder="配信者としてチャットに送る"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            // 日本語入力の変換を確定する Enter は、送信の合図ではない（押すたびに書きかけが送られてしまう）。
            // Safari は確定の Enter で isComposing を false にすることがあるので、処理中を表す keyCode も見る
            event.preventDefault()
            if (event.nativeEvent.keyCode === IME_PROCESSING_KEY_CODE) return
            // 送信のボタンが押せないとき（空欄・送信中）は、Enter でも送らない
            if (!event.nativeEvent.isComposing && !actions.busy && draft !== '') send()
          }}
        />
        <Button type="submit" disabled={actions.busy || draft === ''}>
          <Send aria-hidden="true" />
          送信
        </Button>
      </form>
    </div>
  )
}
