// 日次スナップショット: フォロワー数などを1日1回、管理シートの「日次推移」タブに記録する。
// 毎日23:30 JST以降の最初の起動で記録する(起動が遅れても、その日のうちなら記録される)。
// 使い方:
//   node daily-snapshot.js --dry-run   時刻・記録済みチェックを無視して値を取得し、シートへのアクセス確認だけ行う(書き込まない)
//   node daily-snapshot.js             23:30 JST以降で、本日分が未記録なら記録する

const fs = require('fs');
const path = require('path');
const { apiGet, loadConfig } = require('./oauth-lib');
const sheet = require('./sheet');

const config = loadConfig();
const STATE_FILE = path.join(__dirname, 'snapshot-state.json');
const SNAPSHOT_MINUTES_JST = 23 * 60 + 30;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function nowJst() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const state = readJson('snapshot-state.json', { lastSnapshotDate: null });
  const now = nowJst();
  const today = now.toISOString().slice(0, 10);
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  if (!dryRun) {
    if (state.lastSnapshotDate === today) {
      console.log('本日分は記録済みのためスキップします。');
      return;
    }
    if (minutes < SNAPSHOT_MINUTES_JST) {
      console.log('23:30 JST前のためスキップします。');
      return;
    }
    if (!sheet.isConfigured()) {
      console.log('シートが未設定のため記録しません。');
      return;
    }
  }

  const me = await apiGet(
    'https://api.twitter.com/2/users/me',
    { 'user.fields': 'public_metrics' },
    config.posterAccessToken,
    config.posterAccessSecret
  );
  const m = me.data.public_metrics;

  // 当日の投稿数 = AI投稿(state.json)+ レート投稿(rate-state.json)
  const aiState = readJson('state.json', {});
  const aiCount = aiState.dailyPostCount && aiState.dailyPostCount.date === today ? aiState.dailyPostCount.count : 0;
  const rateCount = readJson('rate-state.json', {}).lastPostedDate === today ? 1 : 0;

  const row = [today, m.followers_count, m.following_count, m.tweet_count, aiCount + rateCount, ''];
  console.log(`日次推移: ${row.slice(0, 5).join(' / ')}`);

  if (dryRun) {
    if (sheet.isConfigured()) console.log('(dry-run) シートアクセスOK。タブ:', (await sheet.listTabs()).join(' / '));
    else console.log('(dry-run) シート未設定のため、アクセス確認はスキップしました。');
    return;
  }

  sheet.queue('日次推移', row);
  if (await sheet.flush()) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastSnapshotDate: today }, null, 2));
  }
}

main().catch((err) => {
  console.error('エラー:', err.message);
  sheet.queue('エラー履歴', [sheet.jstString(), '日次推移', String(err.message).slice(0, 300), sheet.runUrl()]);
  process.exitCode = 1;
}).then(() => sheet.flush());
