/**
 * cron による配信の記録の収集
 *
 * Twitchには過去の視聴者数の推移を返すAPIがなく、取れるのは「いま」の値だけなので、定期的に取得してデータベースへ貯める。
 * 1回の収集で、配信の状態（配信中ならセッションの開始・継続と視聴者数、配信していなければセッションの終了）と、フォロワー数を記録し、
 * あわせて終わった配信の発言から視聴者の人物像を作り（そのついでにその人自身のチャンネルの内容も観測して記録し）、
 * 配信画面を撮った1枚から Gyazo が読み取った文字を取りに行き、
 * あらすじを作り直せたら、そのあらすじに合う BGM を Jev に選ばせ（issue #153。worker/bgm-jev.ts）、
 * 区間が閉じた配信の章（見出しと要約。worker/stream-chapter.ts）を作り、
 * 古くなった記録（first_chatters・stream_chat_messages・transcripts）を消す。
 *
 * 注意: トークンが無い・更新できない・Twitchが失敗を返したときは、黙って飛ばさない。
 * 失敗をデータベース（collection_failures）に記録したうえでエラーを投げ、cron の実行も失敗として残す（Fail-Fast）。
 * 注意: 1回ぶんに時間の予算を持つ（COLLECT_BUDGET_MS。issue #126）。外への呼び出し1回ずつには時間制限が
 * あるが（worker/timeout.ts）、Gyazo を最大30枚とLLMを4か所ぶん逐次に呼ぶので、遅い相手が続くと1回の収集が
 * 積み上がって長くなる。予算を過ぎたら配信の記録は残したまま、材料づくりだけを次の収集へ回す。
 */
import { pushWorkLogEntry, type AlertChannelNamespace } from './alert-channel'
import { BGM_TRANSCRIPT_CONTEXT, chooseBgm } from './bgm-jev'
import type { JevClient } from './jev'
import type { TextGenerator } from './llm'
import { deleteOldFirstChatters } from './chat-store'
import type { Database } from './database'
import {
  deleteOldStreamChatMessages,
  deleteStreamChatMessages,
  listSummaryTargets,
  readRecentSessionChat,
  readSessionChatSince,
  readViewerMessages,
} from './stream-chat-store'
import { readSideSuper, saveSideSuper } from './side-super-store'
import { generateSideSuper } from './side-super'
import { readStreamSummary, saveStreamSummary } from './stream-summary-store'
import { generateStreamSummary } from './stream-summary'
import { listChapterTargets, readChapterLines, saveStreamChapter, skipChapterWindow } from './stream-chapter-store'
import { fitChapterMaterial, generateStreamChapter, nextChapterWindow, type ChapterTarget } from './stream-chapter'
import {
  abandonOcr,
  countOcrAttempt,
  deleteOldScreenCaptures,
  deleteOldScreenLines,
  listPendingOcr,
  listPendingSift,
  readCurrentScreenLines,
  readOwnScreenTexts,
  readRecentScreenLines,
  readScreenLinesSince,
  saveScreenLines,
  saveScreenOcr,
} from './screen-store'
import { createScreenSieve, type ScreenSieve } from './screen-ocr'
import { GyazoApiError, type GyazoClient } from './gyazo'
import { deleteOldTranscripts, readRecentTranscripts, readTranscriptsSince } from './transcript-store'
import { ViewerSummaryContentError, generateViewerSummary } from './viewer-summary'
import { readViewer, updateViewerChannel, updateViewerSummary, type ViewerChannel } from './viewer-store'
import { closeOpenSessions, recordFailure, recordFollowerTotal, recordLiveStream } from './stats-store'
import type { KeyValueStore } from './store'
import { AuthError, getAccessToken } from './token'
import type { TokenVaultNamespace } from './token-vault'
import { TwitchApiError, type ChannelInfo, type LiveStream, type TwitchClient } from './twitch'
import { chapterEntryOf } from './work-log'

const UNAUTHORIZED = 401

/** Gyazo が「その画像は無い」と答えるときの状態コード（配信者が画像を消したときに返る） */
const NOT_FOUND = 404

/**
 * 「その配信で初めての発言」の記録を残しておく期間（ミリ秒）。
 *
 * 判定に使うのは配信中の区切りのぶんだけなので、終わった配信のぶんは残しておく意味がない。
 * それでも1日ぶん残すのは、配信をまたいで遅れて届いた通知（Twitchの再送）にも同じ答えを返すためである。
 * 配信中の区切りのぶんは、この期間を過ぎても消さない（deleteOldFirstChatters を参照）。
 */
const FIRST_CHATTER_RETENTION_MS = 24 * 60 * 60 * 1000

/**
 * 1回の収集で人物像を作る人数の上限。
 *
 * Workers AI の無料枠（1日10,000 Neurons）を一度に使い切らないための歯止めであり、
 * Workers が1回のリクエストで出せる外部への呼び出し（サブリクエスト）の上限への備えでもある。
 * cron は5分おきに動くので、残った人は次の収集で順に処理される。
 */
export const SUMMARY_BATCH_SIZE = 5

/**
 * 1人ぶんの人物像の材料として読む発言の件数の上限。
 *
 * 話し続ける人ほど行が多くなるので、LLMへ渡す量を一定に抑える（Neurons と D1 の rows read の両方の節約）。
 */
const SUMMARY_MESSAGE_LIMIT = 50

/**
 * 1回のあらすじづくりで読む、配信者の発話（文字起こし）の件数の上限。
 *
 * あらすじは前回のあらすじに積み上げる形なので、1回で読むのは前回からの5分ぶんだけでよい。
 * それでも上限を置くのは、押し込みが溜まっていた場合（中継ページのやり直し）に1回の入力が
 * 膨らむのを防ぐためである。超えたぶんは次の収集へ回る。
 */
const STREAM_SUMMARY_TRANSCRIPT_LIMIT = 100

/**
 * 1回のあらすじづくりで読む、視聴者の発言の件数の上限。
 *
 * 発言は文字起こしより短く、盛り上がると一気に増えるので、同じ上限でも入力への効き方が違う。
 * それでも同じ数にしておくのは、どちらか一方だけで材料が埋まらないようにするためである。
 */
const STREAM_SUMMARY_CHAT_LIMIT = 100

/**
 * 1回のあらすじづくりで読む、画面に新しく現れた行の件数の上限。
 *
 * 発話・発言と同じ数にして、どれか1つで材料が埋まらないようにする。篩（worker/screen-ocr.ts）を
 * 通ったあとの行なので、同じ画面を撮り続けているあいだは1行も増えず、この上限に当たるのは
 * 資料を次々に開いた区間だけである。
 */
const STREAM_SUMMARY_SCREEN_LIMIT = 50

/**
 * 人物像の材料（配信中のチャット）を残しておく期間（ミリ秒）。
 *
 * ふつうは人物像を作った時点で消える（deleteStreamChatMessages）ので、ここで消えるのは、
 * LLMを呼べないまま残った材料（無料枠を使い切った日など）だけである。
 * 配信中の発言まで巻き添えにしないよう、1回の配信より十分に長くとる。
 */
export const STREAM_CHAT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 配信中の文字起こしを残しておく期間（ミリ秒）。
 *
 * 文字起こしはあらすじ（issue #65）の材料として配信中だけ持つもので、終わった配信のぶんを残しておく
 * 意味はない。それでも1日ぶん残すのは、配信の直後にあらすじを読み返せるようにするためである。
 * 配信中の区切りのぶんは、この期間を過ぎても消さない（deleteOldTranscripts を参照）。
 */
export const TRANSCRIPT_RETENTION_MS = 24 * 60 * 60 * 1000

/**
 * 配信画面の取り込みの記録を残しておく期間（ミリ秒）。
 *
 * 取り込みも文字起こしと同じく、あらすじ（issue #122）の材料として配信中だけ持つものなので、期間も
 * 文字起こしに揃える。配信中の区切りのぶんは、この期間を過ぎても消さない（deleteOldScreenCaptures を参照）。
 */
export const SCREEN_CAPTURE_RETENTION_MS = TRANSCRIPT_RETENTION_MS

/**
 * 1回の収集に与える時間の予算（ミリ秒）。
 *
 * cron は5分（300秒）おきに動くので、次の起動までに必ず終わる長さにする。2分にしてあるのは、
 * 予算を見るのが処理の切り替わり目だけであり、最後に始めた呼び出しの時間制限（LLMなら60秒）が
 * そのうしろに乗るためである（2分＋60秒でも5分に収まる）。
 *
 * 予算を過ぎても、配信の記録（配信の状態・視聴者数・フォロワー数）と古い記録の掃除は必ず終える。
 * 捨てるのは材料づくり（OCRの取得・あらすじ・サイドスーパー・章・人物像）だけで、どれも次の収集でやり直せる
 * （材料が残っていること自体が「まだ作っていない」という印になっている）。
 */
export const COLLECT_BUDGET_MS = 2 * 60 * 1000

export interface CollectStatsOptions {
  db: Database
  store: KeyValueStore
  /** 配信者のトークンの保管庫（worker/token-vault.ts） */
  tokens: TokenVaultNamespace
  /** 人物像・あらすじ・サイドスーパーを作らせるLLM（worker/llm.ts。呼び先は設定が決める） */
  ai: TextGenerator
  /** 配信の話題に合う BGM を選ばせる Jev（worker/jev.ts） */
  jev: JevClient
  /** Jev が BGM を切り替えたときに、裏方のページへ押し出す配送先 */
  alerts: AlertChannelNamespace
  twitch: Pick<TwitchClient, 'refresh' | 'revoke' | 'getLiveStream' | 'getFollowerTotal' | 'getChannel'>
  /**
   * 配信画面から読み取った文字を取りに行く Gyazo（worker/gyazo.ts）。
   *
   * アクセストークン（GYAZO_ACCESS_TOKEN）が無ければ渡らない。そのときは取りに行かない
   * （トークンが無ければ画面を上げることもできないので、取りに行く先の画像がそもそも増えない）。
   */
  gyazo?: Pick<GyazoClient, 'fetchOcr'>
  broadcasterId: string
  /** 現在時刻（ミリ秒） */
  now: number
  /**
   * 経過を測るための時計（ミリ秒）。既定は Date.now。
   *
   * 記録に使う now と別に持つのは、now が1回の収集で書く行すべてに同じ値を入れる目印であり、
   * 途中で進めると記録の時刻がばらついてしまうためである。テストでは予算を使い切った時刻を返す代役を渡す。
   */
  clock?: () => number
}

/** 失敗の記録に残すコード。AuthError はそのコード（not-logged-in など）を使う */
const toFailureCode = (error: unknown): string => {
  if (error instanceof AuthError) return error.code
  if (error instanceof TwitchApiError) return 'twitch-error'
  return 'internal-error'
}

/**
 * いま進んでいる配信の「これまでのあらすじ」を作り直す（issue #65）。
 *
 * 材料は、前回のあらすじと、そのあとに届いた配信者の発話（transcripts）・視聴者の発言
 * （stream_chat_messages）・画面に新しく現れた文字（screen_lines。issue #122）である。
 * 毎回ゼロから作り直さず積み上げるので、長い配信でも1回あたりの入力が一定に保たれる
 * （worker/stream-summary.ts）。材料ごとに「どこまで渡したか」を持つのも同じ形である。
 *
 * 注意: 配信者の発話が1件も無ければ、画面に文字が現れていてもLLMを呼ばない。画面の文字は機械の
 * 読み取り（誤読を含む断片）なので、それだけを材料にすると読み取った文字がそのまま地の文になる。
 * 画面の文字は、発話があるときにその背景を補う第3の材料として渡す。
 * 注意: 新しい材料が1件も無ければLLMを呼ばない。配信していても喋りも発言もない時間帯はあるので、
 * 5分おきに無駄な Neurons を使わないためである（alert-state.ts の「要らなければ読まない」と同じ考え方）。
 * 注意: 失敗しても収集そのものを止めず、前回のあらすじも消さない。あらすじはチャットのコマンドが
 * 読み出して返すものなので、作り直せなかったときに前回のものが残っていれば、コマンドは無応答にならない。
 * 失敗を黙って飲み込まず collection_failures に残すのは、人物像づくりと同じである。
 *
 * @param sessionId いま進んでいる配信の区切り。Twitchが返した配信のIDがそのまま区切りのIDになる
 *   （stats-store.ts の recordLiveStream）ので、配信中かどうかを引き直さずに済む
 * @returns 作り直したあらすじ。作らなかった・作れなかったときは null（BGM を選ばせるかの目印になる）
 */
const summarizeStream = async (db: Database, ai: TextGenerator, sessionId: string, now: number): Promise<string | null> => {
  const previous = await readStreamSummary(db, sessionId)
  // まだ一度も作っていなければ、どの行よりも前を指す目印（空文字の組）から読む
  const transcriptsFrom = previous?.transcriptsUntil ?? { at: '', messageId: '' }
  const chatFrom = previous?.chatUntil ?? { at: '', messageId: '' }
  // まだ一度も作っていなければ、どの行よりも前を指す目印（並びは0から始まるので -1）から読む
  const screenFrom = previous?.screenUntil ?? { at: '', imageId: '', lineNo: -1 }
  const transcripts = await readTranscriptsSince(db, sessionId, transcriptsFrom, STREAM_SUMMARY_TRANSCRIPT_LIMIT)
  const chats = await readSessionChatSince(db, sessionId, chatFrom, STREAM_SUMMARY_CHAT_LIMIT)
  const screen = await readScreenLinesSince(db, sessionId, screenFrom, STREAM_SUMMARY_SCREEN_LIMIT)
  // 配信者の発話が1件も無いときは、視聴者の発言があっても作らない。書き込みだけを材料にすると、
  // 書き込みの中身が配信で起きたこととして書かれてしまうためである（文字起こしを動かし忘れた配信で実際に起きた）。
  // 目印を進めないので、文字起こしが届いた回で、このあいだの発言もまとめて材料になる
  // （上限（STREAM_SUMMARY_CHAT_LIMIT）を超えて溜まったぶんは、古いほうから何回かに分けて材料になる）。
  // 前回までのあらすじがある場合でも同じく作らない。あらすじという文脈を与えても、書き込みがそのまま
  // 地の文に貼り付く（「時差があるのがよくわかる。え、こわい。」で終わる）ことを、同じ材料で確かめた
  if (transcripts.length === 0) return null

  let summary: string
  try {
    summary = await generateStreamSummary(ai, {
      previous: previous?.summary ?? '',
      transcripts: transcripts.map((line) => line.text),
      chats: chats.map((line) => line.text),
      screen: screen.map((line) => line.text),
    })
  } catch (error) {
    // 返ってきた文そのものの問題（StreamSummaryContentError）も、LLMを呼べなかった失敗も同じ扱いでよい。
    // 対象が1件しかないので、人物像づくりのような「その人を飛ばして次の人へ進む」という分かれ道がない
    await recordFailure(db, 'stream-summary-failed', error instanceof Error ? error.message : String(error), now)
    return null
  }

  // 読めた材料の最後の行を「どこまで材料にしたか」の目印として記録する。件数の上限で切れた残りは、
  // 読む順（発話と発言は日時・メッセージIDの順、画面の文字は積んだ時刻・画像ID・1枚の中の並びの順）で
  // この目印より後ろにあるので、次の収集で読まれる（取りこぼしにはならない）
  const lastSpeech = transcripts.at(-1)
  const lastChat = chats.at(-1)
  const lastScreen = screen.at(-1)
  await saveStreamSummary(
    db,
    {
      sessionId,
      summary,
      transcriptsUntil: lastSpeech ? { at: lastSpeech.at, messageId: lastSpeech.messageId } : transcriptsFrom,
      chatUntil: lastChat ? { at: lastChat.at, messageId: lastChat.messageId } : chatFrom,
      screenUntil: lastScreen ? { at: lastScreen.at, imageId: lastScreen.imageId, lineNo: lastScreen.lineNo } : screenFrom,
    },
    now,
  )
  return summary
}

/**
 * 作り直したあらすじと直近の発話を材料に、配信の話題に合う BGM を Jev に選ばせる（issue #153。worker/bgm-jev.ts）。
 *
 * あらすじを作り直せた回だけ呼ぶ。あらすじは新しい発話があったときだけ作り直されるので、喋っていない時間帯に
 * Jev を呼ばない（docs/principles.md の8「新しい材料が無ければ呼ばない」）。
 *
 * 注意: 失敗しても収集そのものを止めず、曲も変えない。黙って飲み込まず collection_failures に残すのは、あらすじと同じである。
 */
const chooseBgmForStream = async (
  { db, store, jev, alerts }: Pick<CollectStatsOptions, 'db' | 'store' | 'jev' | 'alerts'>,
  sessionId: string,
  summary: string,
  now: number,
): Promise<void> => {
  try {
    const transcript = (await readRecentTranscripts(db, sessionId, BGM_TRANSCRIPT_CONTEXT)).map((line) => line.text)
    await chooseBgm({ store, jev, alerts, now, summary, transcript })
  } catch (error) {
    await recordFailure(db, 'bgm-choice-failed', `配信の話題に合うBGMを選べませんでした: ${error instanceof Error ? error.message : String(error)}`, now)
  }
}

/**
 * 1章の材料として読む件数の上限（材料ごと）。
 *
 * 30分の区間に収まる量を目安にしている。上限を超えた区間は短く切り、残りを次の章へ回す
 * （worker/stream-chapter.ts の fitChapterMaterial）ので、上限は1回の入力の大きさを決めるだけで、取りこぼしにはならない。
 * 発話を多めにしているのは、章が話されたことの記録であり、発話がその中心になるためである。
 */
const CHAPTER_LINE_LIMITS = { transcripts: 300, chats: 200, screen: 100 } as const

/**
 * 1回の収集で見る区間の数の上限。
 *
 * 発話の無い区間はLLMを呼ばずに飛ばすので、長く喋らなかった配信では1回の収集で何区間も進む。
 * D1の読み出しが際限なく増えないように上限を置く（12時間ぶん）。残りは次の収集で続きから見る。
 */
const MAX_CHAPTER_WINDOWS_PER_COLLECT = 24

/**
 * 区間が閉じた配信の章を、1回の収集で1つまで作る。
 *
 * 配信中の配信と、終わりまで章にし終えていない終わった配信が対象である（stream-chapter-store.ts の listChapterTargets）。
 * 配信が終わった回では最後の区間を配信の終わりで切って章にするので、配信していなくても呼ぶ。
 *
 * 注意: 1回の収集で作る章は1つまでにする。LLMが使えなかった日のあとに溜まった区間を一度に作ると、
 * Workers AI の無料枠を一度に使い切るためである。cron は5分おきに動くので、残りは順に作られる。
 * 注意: 発話の無い区間は、LLMを呼ばずに飛ばす。視聴者の書き込みや画面の文字だけを材料にすると、
 * それが配信で起きたこととして書かれるためである（あらすじが発話の無いときに作らないのと同じ理由）。
 * 注意: 失敗しても収集そのものを止めず、区間も進めない（次の収集でやり直す）。区間が進まないあいだは、
 * その配信の人物像も作られない（stream-chat-store.ts の CHAPTERED_SESSIONS）。材料の文字起こしが保持期間で
 * 消えれば、残りの区間は発話の無い区間として飛ばされるので、人物像がいつまでも作られないことはない。
 * 注意: 配信中の配信の章ができたら、見出しを合成ページの素材「作業ログ」へ押し出す（issue #211）。終わった配信の章は
 * 押し出さない（合成ページが映すのは配信中の配信のログだけ）。押し出しの失敗は章づくりの失敗とは分けて記録し、
 * 章は残して区間も進める。作り直すとLLMの枠を使ううえ、合成ページは次の読み直しで取り戻せるためである。
 */
const makeStreamChapter = async (db: Database, ai: TextGenerator, alerts: AlertChannelNamespace, now: number): Promise<void> => {
  let windowCount = 0
  for (const target of await listChapterTargets(db)) {
    let current: ChapterTarget = target
    for (let window = nextChapterWindow(current, now); window !== null; window = nextChapterWindow(current, now)) {
      windowCount += 1
      if (windowCount > MAX_CHAPTER_WINDOWS_PER_COLLECT) return
      const lines = await readChapterLines(db, current.id, window, CHAPTER_LINE_LIMITS)
      // 区間を切れない（上限を超える行がすべて区間の始まりと同じ時刻）ときも、LLMの失敗と同じく記録して打ち切る。
      // ここで投げると、あとに続く人物像づくりまで止まってしまうためである
      let material: ReturnType<typeof fitChapterMaterial>
      try {
        material = fitChapterMaterial(window, lines, CHAPTER_LINE_LIMITS)
      } catch (error) {
        await recordFailure(db, 'stream-chapter-failed', error instanceof Error ? error.message : String(error), now)
        return
      }
      if (material.transcripts.length === 0) {
        await skipChapterWindow(db, current.id, material.to)
        current = { ...current, chapteredUntil: material.to }
        continue
      }
      try {
        const chapter = await generateStreamChapter(ai, {
          title: current.title,
          categoryName: current.categoryName,
          transcripts: material.transcripts.map((line) => line.text),
          chats: material.chats.map((line) => line.text),
          screen: material.screen.map((line) => line.text),
        })
        const saved = { startedAt: material.from, endedAt: material.to, ...chapter }
        await saveStreamChapter(db, { sessionId: current.id, ...saved })
        if (current.endedAt === null) {
          await pushWorkLogEntry(alerts, chapterEntryOf(saved)).catch((error: unknown) =>
            recordFailure(db, 'work-log-push-failed', error instanceof Error ? error.message : String(error), now),
          )
        }
      } catch (error) {
        await recordFailure(db, 'stream-chapter-failed', error instanceof Error ? error.message : String(error), now)
      }
      return
    }
  }
}

/**
 * 1回のサイドスーパーづくりで読む、配信者の発話（文字起こし）の件数の上限。
 *
 * サイドスーパーは「いまの話題」を2行で言い表すものなので、材料も直近のぶんだけでよい。
 * あらすじ（STREAM_SUMMARY_TRANSCRIPT_LIMIT）より少なくしているのは、古い話題まで混ぜると
 * いま画面に出すべき言葉がぼやけるためである。
 */
const SIDE_SUPER_TRANSCRIPT_LIMIT = 20

/**
 * 1回のサイドスーパーづくりで読む、視聴者の発言の件数の上限。
 *
 * 発話と同じ数にして、どちらか一方だけで材料が埋まらないようにする（あらすじと同じ考え方）。
 */
const SIDE_SUPER_CHAT_LIMIT = 20

/**
 * 1回のサイドスーパーづくりで読む、直近に画面へ現れた行の件数の上限。
 *
 * 発話・発言と同じ数にして、どれか1つで材料が埋まらないようにする。
 */
const SIDE_SUPER_SCREEN_LIMIT = 20

/**
 * いま進んでいる配信のサイドスーパーを作り直す。
 *
 * サイドスーパーは配信画面の隅に出しっぱなしにする短いテロップで、材料は直近の発話・発言・
 * 直近に画面へ現れた文字（screen_lines。issue #122）と、配信のカテゴリ・タイトルである。あらすじと違って前回のものに積み上げず、毎回その時点の材料から
 * 作り直す（worker/side-super.ts）。
 *
 * 注意: 前回作ったあとに新しい材料が1件も無ければLLMを呼ばない。喋りも発言もない時間帯に5分おきの
 * 作り直しで Neurons を使わないためである（あらすじの「新しい材料が無ければ呼ばない」と同じ考え方）。
 * 注意: 失敗しても収集そのものを止めず、前回のサイドスーパーも消さない。消すと配信画面から文言が消えてしまう。
 * 失敗を黙って飲み込まず collection_failures に残すのは、あらすじ・人物像づくりと同じである。
 *
 * @param stream いま進んでいる配信。カテゴリとタイトルを材料にするので、配信のIDだけでなくこの形で受け取る
 */
const makeSideSuper = async (db: Database, ai: TextGenerator, stream: LiveStream, now: number): Promise<void> => {
  const previous = await readSideSuper(db, stream.id)
  const transcripts = await readRecentTranscripts(db, stream.id, SIDE_SUPER_TRANSCRIPT_LIMIT)
  const chats = await readRecentSessionChat(db, stream.id, SIDE_SUPER_CHAT_LIMIT)
  const screen = await readCurrentScreenLines(db, stream.id, SIDE_SUPER_SCREEN_LIMIT)
  // 前回作ったあとに届いた材料があるかを、材料そのものの時刻で見る（どれも同じ形の ISO 8601 なので文字列で比べられる）。
  // 画面の文字だけは「以降」（同じ時刻を含む）で見る。篩がサイドスーパーより後に走り、前回と同じ収集の時刻（now）で
  // 行を積むので、「より後」にすると、前回の材料に入っていない行が新しいと見なされない。発話と発言は別のリクエストが
  // 記録するので「より後」で見る（同じ時刻のものは前回の材料に入っており、含めると無駄にLLMを呼ぶ）
  const hasNewMaterial =
    previous === null
      ? transcripts.length > 0 || chats.length > 0 || screen.length > 0
      : [...transcripts, ...chats].some((line) => line.at > previous.updatedAt) ||
        screen.some((line) => line.at >= previous.updatedAt)
  if (!hasNewMaterial) return

  let lines
  try {
    lines = await generateSideSuper(ai, {
      categoryName: stream.categoryName,
      title: stream.title,
      transcripts: transcripts.map((line) => line.text),
      chats: chats.map((line) => line.text),
      screen: screen.map((line) => line.text),
    })
  } catch (error) {
    // 返ってきた行そのものの問題（SideSuperContentError）も、LLMを呼べなかった失敗も同じ扱いでよい
    // （対象が1件しかないので、人物像づくりのような「飛ばして次へ」という分かれ道がない）
    await recordFailure(db, 'side-super-failed', error instanceof Error ? error.message : String(error), now)
    return
  }

  await saveSideSuper(db, stream.id, lines, now)
}

/** その人自身のチャンネルを観測する呼び出し。トークンの取り直しを挟めるよう、Twitchの呼び出しは閉じ込めて渡してもらう */
type ReadChannel = (userId: string) => Promise<ChannelInfo>

/**
 * その人自身のチャンネルの内容（最後に配信したカテゴリとタイトル）を観測して記録する（issue #98）。
 *
 * 人物像を作る人のぶんだけ呼ぶので、1回の収集で増えるTwitchへの問い合わせは SUMMARY_BATCH_SIZE 件までである。
 * 発言の受け口（worker/webhook-routes.ts）では観測しない（Twitchへ2xxを速く返す道に問い合わせを追加しない）。
 *
 * 注意: 観測できなくても人物像づくりは止めない。消えたアカウント・改名などで1人ぶん取れないことは起こりうるが、
 * それでその人の人物像が作られないほうが困る。黙って飛ばすのではなく、理由を failures へ書き足して
 * 呼び出し側にまとめて記録させ（recordChannelFailures）、前に観測した値（あれば）はそのまま残す。
 *
 * @param failures 観測できなかった理由を書き足す配列。ここで直接 recordFailure を呼ばないのは、
 *   失敗の記録が「時刻と種類」で1行しか持てず（migrations/0012_collection_failures_key.sql）、
 *   同じ収集で2人目が失敗すると1人目の理由を上書きして消してしまうためである
 * @returns 観測して記録できた内容。観測できなかった場合と、記録のない人（消された直後）では null
 */
const observeViewerChannel = async (
  db: Database,
  readChannel: ReadChannel,
  userId: string,
  failures: string[],
  now: number,
): Promise<ViewerChannel | null> => {
  try {
    return await updateViewerChannel(db, userId, await readChannel(userId), now)
  } catch (error) {
    failures.push(`ユーザーID ${userId}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * 1回の収集でチャンネルを観測できなかった人の理由を、まとめて1行に記録する。
 *
 * 1人ずつ記録すると、同じ収集の2人目が1人目の行を上書きしてしまう（失敗の記録は「時刻と種類」で1行しか
 * 持てない）。1回に観測するのは SUMMARY_BATCH_SIZE 人までなので、まとめても1行が長くなり過ぎない。
 */
const recordChannelFailures = async (db: Database, failures: readonly string[], now: number): Promise<void> => {
  if (failures.length === 0) return
  await recordFailure(db, 'viewer-channel-failed', `${failures.length}人ぶん観測できませんでした。${failures.join(' / ')}`, now)
}

/**
 * 終わった配信の発言から、視聴者の人物像を作る。
 *
 * 材料が残っていること自体が「まだ作っていない」という印なので、作り終えた人のぶんはその場で消す
 * （stream-chat-store.ts）。1回に処理する人数を SUMMARY_BATCH_SIZE までに抑え、残りは次の収集に回す。
 *
 * 注意: LLMを呼べなかった失敗（無料枠切れ・通信の失敗）では、そこで打ち切って失敗を記録し、材料は消さずに残す。
 * 枠切れならその後の人も必ず失敗するので、同じ失敗を人数分積み上げない。材料が残るので次の収集でやり直せる。
 * 注意: 返ってきた人物像そのものに問題があった失敗（ViewerSummaryContentError）では、その人だけを飛ばして次へ進む。
 * その人の材料からは何度やっても同じ結果になりやすいので、打ち切るとその人が列の先頭（発言の多い順）を塞ぎ続け、
 * ほかの人の人物像がいつまでも作られない。飛ばした人の材料は残るので、次の収集でやり直され、
 * それでも作れなければ保持期間（STREAM_CHAT_RETENTION_MS）で消える。
 * 注意: この失敗で収集そのものを止めない。LLMが使えない日に、配信の記録（視聴者数・フォロワー数）まで
 * 止まってしまうのを避けるためである。黙って飛ばすのではなく collection_failures に残し、管理画面から気づけるようにする。
 * 注意: 1人ごとに収集の時間の予算を見る（issue #126）。1人にLLMとTwitchを1回ずつ呼ぶので、5人ぶんを
 * まとめて始めると、入口では予算内だったのに終わりが次の cron の起動に食い込むことがある。
 *
 * @returns 予算を使い切って手を付けなかった人数（呼び出し側がまとめて記録する）
 */
const summarizeViewers = async (
  db: Database,
  ai: TextGenerator,
  readChannel: ReadChannel,
  now: number,
  budgetExhausted: () => boolean,
): Promise<number> => {
  const targets = await listSummaryTargets(db, SUMMARY_BATCH_SIZE)
  /** チャンネルを観測できなかった人の理由。1回の収集ぶんをまとめて1行に記録する（recordChannelFailures） */
  const channelFailures: string[] = []
  let touched = 0
  for (const target of targets) {
    if (budgetExhausted()) {
      await recordChannelFailures(db, channelFailures, now)
      return targets.length - touched
    }
    touched += 1
    const viewer = await readViewer(db, target.userId)
    // 記録を消された人（本人から求められて削除した場合）の材料は、LLMもTwitchも呼ばずに捨てる
    if (viewer === null) {
      await deleteStreamChatMessages(db, target.userId)
      continue
    }

    // 観測できた内容はその場で人物像の材料にも渡す（記録だけして次の収集まで待たせない）
    const channel = await observeViewerChannel(db, readChannel, target.userId, channelFailures, now)
    const messages = await readViewerMessages(db, target.userId, SUMMARY_MESSAGE_LIMIT)
    let summary: string
    try {
      summary = await generateViewerSummary(ai, { viewer: channel === null ? viewer : { ...viewer, channel }, messages })
    } catch (error) {
      await recordFailure(db, 'viewer-summary-failed', error instanceof Error ? error.message : String(error), now)
      if (error instanceof ViewerSummaryContentError) continue
      // 打ち切るときも、ここまでに観測できなかった理由は記録する（return ではなく break にしてある）
      break
    }

    await updateViewerSummary(db, target.userId, summary, now)
    await deleteStreamChatMessages(db, target.userId)
  }

  await recordChannelFailures(db, channelFailures, now)
  return 0
}

/**
 * 1回の収集で、OCRを取りに行く画像の枚数の上限。
 *
 * cron は5分おきに動くので、15秒間隔で撮っていれば1回あたり20枚ほど貯まる。それを取りきれる枚数にしつつ、
 * Workers が1回のリクエストで出せる外部への呼び出し（サブリクエスト）の上限への備えとして抑える。
 * 取りきれなかったぶんは次の収集で順に処理される。
 */
export const SCREEN_OCR_BATCH_SIZE = 30

/**
 * 上げた画像から、Gyazo が読み取った文字を取りに行く（issue #122 Phase 2）。
 *
 * 上げた直後は生成が終わっていない（実測で約10〜13秒）ので、上げるときには取らず、ここでまとめて取りに行く。
 * まだ生成されていなければ記録せず、試みた回数だけを数えて次の収集へ回す（worker/screen-store.ts の
 * OCR_MAX_ATTEMPTS に達したら諦める）。
 *
 * 注意: 失敗しても収集そのものを止めない。画面の文字は補助的な材料なので、Gyazo が使えない日に配信の記録
 * （視聴者数・フォロワー数）まで止めない（人物像づくりと同じ扱い）。黙って飛ばさず collection_failures に残す。
 * 注意: 1枚で失敗したら残りは取りに行かない。失敗の理由（トークンが無効・Gyazo が落ちている）は
 * たいてい次の1枚でも同じなので、続けても外への呼び出しを無駄に使うだけである。
 * 注意: ただし「その画像が無い」（404）だけは、その1枚を諦めて先へ進む。配信者が Gyazo から画像を消すと
 * 起こりうるが、これは次の1枚には当てはまらない理由である。諦めずに止めると、撮った順に引く以上その1枚が
 * 先頭に居座り続け、以降どの収集でも後ろの1枚に永久にたどり着けなくなる。
 */
const fetchScreenOcr = async (
  db: Database,
  gyazo: Pick<GyazoClient, 'fetchOcr'>,
  now: number,
  budgetExhausted: () => boolean,
): Promise<number> => {
  const pending = await listPendingOcr(db, SCREEN_OCR_BATCH_SIZE)
  let fetched = 0
  for (const capture of pending) {
    // 1枚ごとに見るのは、遅い相手が続くと30枚ぶんが積み上がるためである。取れたぶんはそのまま残る
    if (budgetExhausted()) return pending.length - fetched
    fetched += 1
    let text: string | null
    try {
      text = await gyazo.fetchOcr(capture.imageId)
    } catch (error) {
      await recordFailure(db, 'screen-ocr-failed', error instanceof Error ? error.message : String(error), now)
      if (error instanceof GyazoApiError && error.status === NOT_FOUND) {
        await abandonOcr(db, capture.imageId)
        continue
      }
      break
    }
    if (text === null) await countOcrAttempt(db, capture.imageId)
    else await saveScreenOcr(db, capture.imageId, text)
  }
  return 0
}

/**
 * 予算を過ぎて次の収集へ回したものを、まとめて1行に記録する（issue #126）。
 *
 * 1つずつ記録すると、同じ収集の2つめが1つめの行を上書きしてしまう（失敗の記録は「時刻と種類」で1行しか
 * 持てない。migrations/0012_collection_failures_key.sql）ので、チャンネルの観測（recordChannelFailures）と
 * 同じくまとめて書く。
 */
const recordBudgetExceeded = async (db: Database, deferred: readonly string[], now: number): Promise<void> => {
  if (deferred.length === 0) return
  await recordFailure(
    db,
    'collect-budget-exceeded',
    `1回の収集の時間の予算（${COLLECT_BUDGET_MS / 1000}秒）を過ぎたので、${deferred.join('・')}を次の収集へ回しました`,
    now,
  )
}

/**
 * 1回の収集で篩にかける画像の枚数の上限。
 *
 * OCRを取りに行く枚数（SCREEN_OCR_BATCH_SIZE）と揃える。同じ収集の中で取ってすぐ篩にかけるので、
 * ここを小さくすると取れた文字が篩の前で溜まっていくだけになる。
 */
export const SCREEN_SIFT_BATCH_SIZE = SCREEN_OCR_BATCH_SIZE

/**
 * 篩の1段目（自前の文字の除去）で照らす、視聴者の発言と配信者の発話の件数。
 *
 * 画面に映り込むのは直近のぶんだけ（チャットボックスと字幕はどちらも数行しか出ない）なので、
 * 配信の序盤まで遡っても落とせる行は増えない。
 */
const OWN_TEXT_LIMIT = 50

/**
 * 篩の3段目（既出の除去）で照らす、既に渡した行の件数。
 *
 * 同じ画面を撮り続けたぶんを畳むのが目的なので、いま映っている画面の近くだけで足りる。
 * 全部と照らす形にすると、配信が長くなるほど1枚あたりの比較が増えていく。
 */
const SEEN_LINE_LIMIT = 300

/**
 * 読み取った文字を篩にかけ、画面に新しく現れた行だけを積む（issue #122 Phase 3）。
 *
 * 篩そのものは worker/screen-ocr.ts が持ち、ここは材料（自前の文字・既に渡した行）を読んで渡すだけである。
 *
 * 注意: 篩は配信の区切りごとに一度だけ作り、同じ収集の何枚もを同じ篩に通す。1枚ごとに材料を読み直すと
 * D1の読み出しが枚数ぶん増え、篩を作り直すと材料の前処理が枚数ぶん積み上がる（Workers の Free プランでは
 * CPU 時間が1回10msしかなく、配信の終盤にこれを超えて cron ごと止まっていた）。篩は残した行をその場で
 * 既出に加えるので、同じ収集で処理する2枚目以降が1枚目と同じ行を積むこともない。
 * 注意: 残った行が0行でも、その1枚は通し終えたことにする（saveScreenLines が sifted_at を入れる）。
 * 同じ画面を撮り続けるあいだ0行になるのが普通で、通し直す意味がない。
 */
const siftScreenOcr = async (db: Database, now: number): Promise<void> => {
  const pending = await listPendingSift(db, SCREEN_SIFT_BATCH_SIZE)
  const sieves = new Map<string, ScreenSieve>()

  for (const capture of pending) {
    let sieve = sieves.get(capture.sessionId)
    if (!sieve) {
      const own = await readOwnScreenTexts(db, capture.sessionId, OWN_TEXT_LIMIT)
      const seen = await readRecentScreenLines(db, capture.sessionId, SEEN_LINE_LIMIT)
      sieve = createScreenSieve(own, seen)
      sieves.set(capture.sessionId, sieve)
    }

    const lines = sieve.extract(capture.ocrText)
    await saveScreenLines(db, capture, lines, now)
  }
}

const collect = async ({ db, store, tokens, twitch, ai, jev, alerts, gyazo, broadcasterId, now, clock = Date.now }: CollectStatsOptions): Promise<void> => {
  const startedAt = clock()
  const budgetExhausted = (): boolean => clock() - startedAt > COLLECT_BUDGET_MS
  /** 予算を過ぎて次の収集へ回したもの。まとめて1行に記録する */
  const deferredToNextCollect: string[] = []
  /** 予算が残っていれば作り、使い切っていたら手を付けずに次の収集へ回す */
  const withinBudget = async <Result>(name: string, create: () => Promise<Result>): Promise<Result | undefined> => {
    if (budgetExhausted()) {
      deferredToNextCollect.push(name)
      return undefined
    }
    return await create()
  }

  let token = await getAccessToken(tokens, 'broadcaster', twitch, now)
  let refreshed = false

  /** 保管しているトークンでTwitchを呼ぶ。期限内でもTwitch側で無効になっていることがあるので、401なら1回だけ取り直してやり直す */
  const callTwitch = async <Result>(call: (accessToken: string) => Promise<Result>): Promise<Result> => {
    try {
      return await call(token.accessToken)
    } catch (error) {
      const tokenRejected = error instanceof TwitchApiError && error.status === UNAUTHORIZED
      if (!tokenRejected || refreshed) throw error
      refreshed = true
      token = await getAccessToken(tokens, 'broadcaster', twitch, now, { forceRefresh: true })
      return await call(token.accessToken)
    }
  }

  // 片方の取得に失敗しても、先に取れたほうの記録は残す
  const stream = await callTwitch((accessToken) => twitch.getLiveStream(accessToken, broadcasterId))
  if (stream) await recordLiveStream(db, stream, now)
  else await closeOpenSessions(db, now)

  const followerTotal = await callTwitch((accessToken) => twitch.getFollowerTotal(accessToken, broadcasterId))
  await recordFollowerTotal(db, followerTotal, now)

  // 配信を重ねるほど行が積み上がるので、収集のついでに古いぶんを消す
  await deleteOldFirstChatters(db, now - FIRST_CHATTER_RETENTION_MS)
  await deleteOldStreamChatMessages(db, now - STREAM_CHAT_RETENTION_MS)
  await deleteOldTranscripts(db, now - TRANSCRIPT_RETENTION_MS)
  await deleteOldScreenCaptures(db, now - SCREEN_CAPTURE_RETENTION_MS)
  await deleteOldScreenLines(db, now - SCREEN_CAPTURE_RETENTION_MS)

  // あらすじづくりと人物像づくりは、配信の記録を残したあとに行う（LLMが使えなくても記録は残す）。
  // あらすじを先にするのは、配信中の視聴者がコマンドで読むものであり、待たせる相手がいるためである
  // （人物像は終わった配信のぶんを作るので、1回遅れても誰も困らない）。無料枠は両者で分け合う。
  // 1つ作るごとに予算を見るのは、LLMの呼び出しが1回で最大60秒かかるので、入口で1度見るだけでは
  // 3つぶん（あらすじ・サイドスーパー・人物像5人）が次の cron の起動に食い込むためである（issue #126）
  if (stream) {
    const summary = await withinBudget('あらすじ', () => summarizeStream(db, ai, stream.id, now))
    if (typeof summary === 'string') await withinBudget('BGMの切り替え', () => chooseBgmForStream({ db, store, jev, alerts }, stream.id, summary, now))
    await withinBudget('サイドスーパー', () => makeSideSuper(db, ai, stream, now))
  }

  // 画面から読み取った文字は、あらすじとサイドスーパーより後に取りに行き、篩にかける（積んだ行は次の収集で材料になる）。
  // 先に行っていたころは、篩が Workers の CPU 時間の上限（Free プランで1回10ms）を超えると cron ごと強制終了され、
  // 配信の終盤にあらすじもサイドスーパーも止まった。強制終了は例外として捕まえられず、collection_failures にも残らない。
  // 章立てより前に行うのは、章が画面の文字を積んだ時刻で区間に振り分けるためである。
  // 篩は Gyazo を呼ばないので、トークンが無くても（前の収集で取れているぶんを）通す
  if (gyazo) {
    const keptCount = await fetchScreenOcr(db, gyazo, now, budgetExhausted)
    if (keptCount > 0) deferredToNextCollect.push(`画面の文字の取得（残り${keptCount}枚）`)
  }
  // 篩は外へ出ないので、予算を過ぎていても通す（通さないと、取れた文字が篩の前で溜まっていくだけになる）
  await siftScreenOcr(db, now)

  // 章立ては人物像より先に行う。人物像を作ると発言の材料が消えるので、配信が終わった回の最後の章から
  // 視聴者の反応が抜けないようにするためである（人物像は、章にし終えた配信の発言だけを材料にする）
  await withinBudget('章立て', () => makeStreamChapter(db, ai, alerts, now))
  if (budgetExhausted()) {
    deferredToNextCollect.push('人物像')
  } else {
    const keptPeople = await summarizeViewers(db, ai, (userId) => callTwitch((accessToken) => twitch.getChannel(accessToken, userId)), now, budgetExhausted)
    if (keptPeople > 0) deferredToNextCollect.push(`人物像（残り${keptPeople}人）`)
  }
  await recordBudgetExceeded(db, deferredToNextCollect, now)
}

/**
 * 1回分の収集を行う。
 *
 * @throws AuthError 未ログイン・再ログインが必要（失敗を記録したうえで投げる）
 * @throws TwitchApiError Twitchが失敗を返した（同上）
 */
export const collectStats = async (options: CollectStatsOptions): Promise<void> => {
  try {
    await collect(options)
  } catch (error) {
    await recordFailure(options.db, toFailureCode(error), error instanceof Error ? error.message : String(error), options.now)
    throw error
  }
}
