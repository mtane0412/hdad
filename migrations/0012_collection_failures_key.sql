-- 収集の失敗（collection_failures）の主キーに「失敗の種類」を足す
--
-- 適用方法は README.md の「配信の記録」を参照。
--
-- cron（worker/collect.ts）は1回の実行で複数の仕事（配信の記録・あらすじ・サイドスーパー・人物像）を行い、
-- どの失敗も同じ「いまの時刻」で記録する。主キーが occurred_at だけだと、あとから起きた失敗が
-- 先に起きた失敗を上書きして消してしまい、原因の並びが読めなくなる（Workers AI の無料枠が切れた回では、
-- あらすじ・サイドスーパー・人物像が同時に失敗する）。種類ごとに1行持てるよう、主キーを (occurred_at, code) にする。
--
-- 同じ時刻に同じ種類の失敗が二度記録されたときに行を増やさない性質は、そのまま残す（ON CONFLICT で上書きする）。
--
-- SQLite は主キーを変えられないので、作り直して移し替える。
CREATE TABLE collection_failures_v2 (
  occurred_at TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (occurred_at, code)
) WITHOUT ROWID;

INSERT INTO collection_failures_v2 (occurred_at, code, message)
SELECT occurred_at, code, message FROM collection_failures;

DROP TABLE collection_failures;

ALTER TABLE collection_failures_v2 RENAME TO collection_failures;
