# x-auto-tac-bot

TAC_FXtrade(YouTube「TACテクニカル分析講座」の公式X)の自動投稿ボット。
GitHub Actions + cron-job.org(外部トリガー、15分おき)で、2種類の投稿を自動化している。

| 投稿 | 時刻(JST) | スクリプト | 内容 |
|---|---|---|---|
| AI生成投稿 | 毎日13:00(1回) | `tac-post.js` | Claude Codeが話題・切り口を変えて文章を生成し投稿 |
| ドル円レート発表 | 毎日9:00以降(1回) | `rate-post.js` | Yahoo Financeの現在レートを固定フォーマット+画像で投稿(AI不使用) |

各スクリプトは「時刻が来ていて本日未投稿か」だけを判定するため、起動が遅延しても自動でキャッチアップする。
状態は `state.json`(AI投稿)・`rate-state.json`(レート投稿)に保存される。

## ドル円レート投稿の仕様

```
サトシ「ピカチュウ！かわせ！」

ピカチュウ「米ドル/円　157.78」   ← 小数点2桁、全角スペース区切り
[画像: rate-announce.jpg]
```

- レート取得: Yahoo Finance(`USDJPY=X`)。取得失敗・異常値・4日以上古い値は投稿せず、次回の起動で再試行
- 画像: `rate-announce.jpg` を差し替えれば画像を変更できる(5MB以下のJPEG)
- 動作確認: `node rate-post.js --dry-run`(投稿せず、レート取得と文面のみ確認)。
  GitHub上で試す場合は Actions → TAC Auto Post → Run workflow で `rate_dry_run` にチェック

## 年1回のメンテナンスが必要な項目

**`CLAUDE_CODE_OAUTH_TOKEN` は発行から1年で失効します。**
`claude setup-token` はAnthropic側の仕様で有効期限を1年より延長できません
(2026年9月確認済み)。期限が切れると投稿が止まります。

### 更新手順(1年ごと)

1. ターミナルで `claude setup-token` を実行し、ブラウザでログイン・承認
2. 表示された新しいトークン(`sk-ant-oat01-...`)をコピー
3. 以下のコマンドでGitHub Secretsを更新:
   ```
   gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo businessfxtrader-rgb/x-auto-tac-bot --body "<新しいトークン>"
   ```

最終更新: 2026年9月2日発行(次回更新目安: 2027年9月頃)

## その他の定期確認事項

- X APIの請求サイクル上限($6/月)を [console.x.com](https://console.x.com) でたまに確認
- X APIクレジット残高の自動チャージ(カード)が有効な状態か確認
