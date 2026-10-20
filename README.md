# 戦国布武 武将図鑑 (AI スクリーンショット解析)

スマホゲーム『戦国布武～我が天下戦国乱世演武～』の武将画面スクリーンショットをアップロードすると、
Claude (Vision) が武将情報・成長値・奥義・覚醒 (専用武器覚醒)・天賦・連携スキルを読み取り、
SQLite に保存して図鑑として閲覧・検索・編集できる Web アプリです。

## 必要環境

- Node.js **22.13 以上** (組み込みの `node:sqlite` を使用。ネイティブビルド不要)
- Anthropic API キー

## セットアップ

```bash
npm install
cp .env.example .env   # ANTHROPIC_API_KEY を設定
npm run dev            # API: http://localhost:3001 / 画面: http://localhost:5173
```

本番起動:

```bash
npm run build
npm start              # http://localhost:3001 で画面と API を配信
```

テスト / 型チェック:

```bash
npm test
npm run typecheck
```

## 設定 (.env)

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | 必須 |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | 解析モデル |
| `CLAUDE_EFFORT` | `low` | 思考量 (`low` / `medium` / `high`)。読み取りが不安定なら `medium` |
| `CLAUDE_TIMEOUT_MS` | `45000` | 1 リクエストのタイムアウト |
| `CLAUDE_MAX_RETRIES` | `2` | 429 / 5xx / タイムアウト時の自動リトライ回数 |
| `CLAUDE_FALLBACKS` | `on` | AI が拒否した場合のサーバー側フォールバック。プロキシ経由などで 400 になる場合は `off` |
| `PORT` | `3001` | API ポート |
| `DATA_DIR` | `./data` | DB (`warlords.db`) と画像 (`uploads/`) の保存先 |

> 指定仕様の `claude-3-5-sonnet` / `claude-3-7-sonnet` は提供終了済みのため、現行の Sonnet (`claude-sonnet-5-5`) を既定にしています。

## 仕組み

```
ブラウザ ──(画像 multipart)──▶ POST /api/uploads ──▶ data/uploads に保存 + ジョブ登録 (SQLite)
                                                     │
                       バックグラウンドワーカー (1 枚ずつ直列) ◀┘
                         1. sharp で長辺 2000px に縮小 → Base64
                         2. Claude に構造化出力 (JSON Schema 固定) で解析させる
                         3. 【特】判定 → (武将名, 通常/特異) で既存レコードを検索
                         4. 安全にマージ → 保存
ブラウザ ◀──(1.5 秒ごとにポーリング)── GET /api/jobs  → 進捗バー・トースト通知
```

### 構造化出力による JSON の保証

Claude API の Structured Outputs (`output_config.format` + Zod スキーマ, `src/server/ocrSchema.ts`) を使っているため、
応答は常にスキーマどおりの JSON になり、「マークダウンが混ざって JSON パースに失敗する」類のエラーが起きません。
画面に写っていない項目は `null` で返させ、推測で埋めさせないようにしています。

### 通常武将 / 特異武将の分離

- DB は `(name, is_special)` に UNIQUE 制約。通常と特異は常に別レコードです。
- 自動判定は「画面に【特】の表記が写っているか」だけで行います。特定の武将やスキルに関する知識は持たせていません。
- アップロード時に「強制: 通常武将 / 強制: 特異武将」を選ぶと自動判定より優先されます。
- 武器覚醒後の効果は、AI が「この画像に武器覚醒の表示が写っている」と答えた場合だけ採用します。

### 複数スクショの統合ルール

| 項目 | ルール |
| --- | --- |
| 空欄 | 新しい画像の値で埋める |
| 二つ名・スキル名・成長率など | 既存値を保持 (誤読による上書き防止)。食い違いはジョブに警告表示 |
| スキル / 覚醒の効果文 | 長い方を採用 (画面端で途切れた文を補完) |
| Lv・星 | 大きい方 |
| 基礎値 | Lv が同じか上がった時に更新 |
| 天賦 | 星ごとに統合、解放状態は OR |
| 連携スキル | 相手武将ごとに統合 |
| 兵種 | 一覧は和集合、現在の兵種は最新 |
| 画像 | `gallery_images` に追加し `screenshot_count` を更新 |

武将名が写っていない画面 (天賦だけ等) は、アップロード時に「統合先の武将」を指定してください。

## API

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/warlords` | 全武将 |
| POST | `/api/warlords` | 手動登録 |
| PUT | `/api/warlords/:id` | 編集 |
| DELETE | `/api/warlords/:id` | 削除 (参照されなくなった画像も削除) |
| POST | `/api/uploads` | 画像アップロード (`files[]`, `mode`, `target_id`) → ジョブ作成 |
| GET | `/api/jobs` | 解析ジョブ一覧 |
| POST | `/api/jobs/:id/retry` | 失敗ジョブの再試行 |
| DELETE | `/api/jobs/finished` | 完了済みジョブの消去 |
| GET | `/api/export` | 全データ JSON エクスポート |
| POST | `/api/import?mode=merge\|replace` | JSON インポート |

エクスポート JSON には画像が URL として含まれます。別環境へ移す場合は `data/uploads/` も一緒にコピーしてください。

## ディレクトリ構成

```
src/
  shared/types.ts          フロント・バック共通の型 (Warlord など)
  server/
    index.ts               Express API
    ocr.ts                 Claude 呼び出し (画像前処理・タイムアウト・リトライ・エラー変換)
    ocrSchema.ts           構造化出力スキーマ
    domain.ts              正規化・【特】判定・マージ (純粋関数)
    ingest.ts              OCR 結果を DB に統合
    jobs.ts                バックグラウンド解析キュー
    db.ts                  SQLite
  client/                  React + Tailwind CSS の画面
```
