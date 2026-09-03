# x-auto-tac-bot

TAC_FXtrade(YouTube「TACテクニカル分析講座」の公式X)の自動投稿ボット。
GitHub Actions + cron-job.org(外部トリガー)で、毎日7:30/19:00 JSTに
Claude Codeが投稿文を生成し、そのままXに自動投稿する。

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
