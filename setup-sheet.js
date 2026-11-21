// TAC管理シートの初期設定(不足しているタブとヘッダー行を作る)。何度実行しても同じ結果になる。
// 使い方:
//   node setup-sheet.js --check   シートにアクセスできるか確認し、タブ名を表示するだけ(変更しない)
//   node setup-sheet.js           不足しているタブとヘッダー行を作成する
// 事前に環境変数 SHEET_ID と、GOOGLE_SERVICE_ACCOUNT_JSON または GOOGLE_SERVICE_ACCOUNT_FILE を設定する。

const sheet = require('./sheet');

async function main() {
  if (!sheet.isConfigured()) {
    throw new Error('SHEET_ID と、GOOGLE_SERVICE_ACCOUNT_JSON(または _FILE)を設定してください。');
  }
  if (process.argv.includes('--check')) {
    const tabs = await sheet.listTabs();
    console.log('アクセスOK。現在のタブ:', tabs.join(' / '));
    return;
  }
  const r = await sheet.ensureTabs();
  console.log('作成したタブ:', r.created.join(' / ') || 'なし');
  console.log('ヘッダー行を書き込んだタブ:', r.headerWritten.join(' / ') || 'なし');
  console.log('既にヘッダーがあり変更しなかったタブ:', r.skipped.join(' / ') || 'なし');
}

main().catch((err) => {
  console.error('エラー:', err.message);
  process.exit(1);
});
