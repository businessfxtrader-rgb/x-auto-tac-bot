// ドル円レート発表ボット(平日の毎朝8:00 JST前後)
// Yahoo Financeから現在のドル円レートを取得し、固定フォーマット+画像でXに投稿する。
// AI生成は使わない(tac-post.jsとは独立)。
// 使い方:
//   node rate-post.js --dry-run   レート取得と投稿文の確認のみ(時刻・投稿済みチェックは無視、投稿しない)
//   node rate-post.js             平日の8:00 JST以降で、本日未投稿なら投稿する

const fs = require('fs');
const path = require('path');
const { apiPostJson, apiPostMultipart, loadConfig } = require('./oauth-lib');

const config = loadConfig();
const STATE_FILE = path.join(__dirname, 'rate-state.json');
const IMAGE_FILE = path.join(__dirname, 'rate-announce.jpg');
const POST_TIME_MINUTES_JST = 8 * 60;
const MAX_RATE_AGE_SECONDS = 4 * 24 * 60 * 60;

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { lastPostedDate: null, lastRate: null, lastTweetId: null };
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function nowJst() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

async function fetchUsdJpy() {
  for (const host of ['query1', 'query2']) {
    try {
      const res = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/USDJPY=X?interval=1d&range=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const meta = (await res.json()).chart.result[0].meta;
      const price = meta.regularMarketPrice;
      if (typeof price !== 'number' || price < 50 || price > 300) throw new Error(`異常なレート: ${price}`);
      const ageSeconds = Date.now() / 1000 - meta.regularMarketTime;
      if (ageSeconds > MAX_RATE_AGE_SECONDS) throw new Error(`レートが古すぎます(${Math.round(ageSeconds / 3600)}時間前)`);
      console.log(`${host}: USD/JPY ${price} (${Math.round(ageSeconds / 60)}分前の値)`);
      return price;
    } catch (err) {
      console.error(`${host}での取得に失敗: ${err.message}`);
    }
  }
  return null;
}

function buildText(rate) {
  return `サトシ「ピカチュウ！かわせ！」\n\nピカチュウ「米ドル/円　${rate.toFixed(2)}」`;
}

async function uploadImage() {
  const form = new FormData();
  form.append('media', new Blob([fs.readFileSync(IMAGE_FILE)], { type: 'image/jpeg' }), 'rate.jpg');
  form.append('media_category', 'tweet_image');
  form.append('media_type', 'image/jpeg');
  const res = await apiPostMultipart('https://api.x.com/2/media/upload', form, config.posterAccessToken, config.posterAccessSecret);
  return res.data.id;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const state = loadState();
  const now = nowJst();
  const today = now.toISOString().slice(0, 10);
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  if (!dryRun) {
    const dayOfWeek = now.getUTCDay(); // nowJst()はUTCメソッドでJSTの値を読む(0=日, 6=土)
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      console.log('土日は為替市場が閉まっているためスキップします。');
      return;
    }
    if (state.lastPostedDate === today) {
      console.log('本日分は投稿済みのためスキップします。');
      return;
    }
    if (minutes < POST_TIME_MINUTES_JST) {
      console.log('8:00 JST前のためスキップします。');
      return;
    }
  }

  const rate = await fetchUsdJpy();
  if (rate === null) throw new Error('ドル円レートを取得できませんでした(次回の実行で再試行します)');

  const text = buildText(rate);
  console.log('投稿内容:\n' + text);

  if (!fs.existsSync(IMAGE_FILE)) throw new Error(`画像が見つかりません: ${IMAGE_FILE}`);
  if (dryRun) {
    console.log(`(dry-run) 画像: ${IMAGE_FILE} (${fs.statSync(IMAGE_FILE).size}バイト) / 投稿はスキップしました。`);
    return;
  }

  const mediaId = await uploadImage();
  const posted = await apiPostJson(
    'https://api.twitter.com/2/tweets',
    { text, media: { media_ids: [mediaId] } },
    config.posterAccessToken,
    config.posterAccessSecret
  );
  console.log(`投稿しました(tweet id: ${posted.data.id})`);

  saveState({ lastPostedDate: today, lastRate: rate, lastTweetId: posted.data.id });
}

main().catch((err) => {
  console.error('エラー:', err.message);
  process.exit(1);
});
