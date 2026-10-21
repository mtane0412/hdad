-- チャットで推理のゲームを始めたチャンネルポイントの報酬（トリガーの動作 chatDeduction で始めたとき）
--
-- トリガーのチャンネルポイントで始めたゲームは、そのあいだ始めた報酬を交換できないようにし、終えたら交換できるように戻す。
-- 戻す報酬を終えるときに知るため、ゲームの行に報酬のIDを控える。/chat-deduction/ のページから始めたゲームは NULL。
-- 読み書きは worker/chat-deduction-store.ts だけが行う。適用方法は docs/guide/stats.md を参照。
ALTER TABLE chat_deduction_games ADD COLUMN start_reward_id TEXT;
