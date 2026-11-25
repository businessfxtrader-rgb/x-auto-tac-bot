// TAC管理シート(Googleスプレッドシート)への記録用モジュール(依存ライブラリなし)
// サービスアカウントでSheets APIに書き込む。
// 方針: 記録の失敗は投稿処理を止めない。環境変数が未設定のときは何もしない。
//
// 環境変数:
//   SHEET_ID                      管理シートのID(リポジトリには書かない。GitHub Secretsで渡す)
//   GOOGLE_SERVICE_ACCOUNT_JSON   サービスアカウントの鍵(JSON文字列)  ※どちらか一方
//   GOOGLE_SERVICE_ACCOUNT_FILE   サービスアカウントの鍵ファイルのパス(ローカル確認用)

const crypto = require('crypto');
const fs = require('fs');

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

// 「フォロバ履歴」タブは既存(移植元と同じ構成)のため、ここでは作らない・触らない
const TAB_DEFINITIONS = [
  {
    title: '投稿履歴',
    headers: ['日時(JST)', '種別', '枠', 'カテゴリ', '切り口', '文字数(換算)', 'URL有無', 'tweet_id', '本文'],
  },
  {
    title: '投稿成績',
    headers: ['tweet_id', '取得日時(JST)', 'インプレッション', 'いいね', 'リポスト', '返信', '引用', 'ブックマーク'],
  },
  {
    title: '日次推移',
    headers: ['日付(JST)', 'フォロワー数', 'フォロー数', '総ポスト数', '当日の投稿数', '承認待ち数'],
  },
  {
    title: 'エラー履歴',
    headers: ['日時(JST)', '処理', '内容', '実行ログ'],
  },
  // 以下はフォロバ機能用
  {
    title: 'フォロバ候補',
    headers: ['ユーザーID', 'ユーザー名', '種別', 'アカウント作成日', '初回確認日', '状態', '試行回数', '鍵', 'メモ'],
  },
  {
    title: 'API利用',
    headers: ['日付(JST)', '種別', '件数', '概算費用($)', 'サイクル開始日'],
  },
  {
    title: '設定',
    headers: ['項目', '値', '説明'],
    initialRows: [
      ['フォロバ自動化', 'OFF', 'ONにすると自動フォロー・解除が動きます。OFFの間は何もしません(APIも呼びません)'],
      ['フォロー上限(件/日)', 5, ''],
      ['解除上限(件/日)', 5, ''],
      ['月予算ガード($/サイクル)', 5, 'フォロー・解除・一覧読取の概算費用がこの額に達したら、そのサイクルは停止します(サイクルは毎月11日開始)'],
      ['アカウント作成からの最低日数', 30, 'これより新しいアカウントにはフォローバックしません'],
      ['フォロワー読取単価($/件)', 0.01, 'consoleで確認済み(2026-11-24): 200件=約$2.00 → 1件$0.010'],
      ['一覧の全件読み取り', 'OFF', 'OFFの間は先頭200人だけ読む(初回のみ)。読取単価を確認してからONにすると、月1回全件を読んで解除候補も検出する'],
    ],
  },
];

let cachedToken = null;
const pending = new Map(); // タブ名 -> 追記待ちの行

function isConfigured() {
  return !!(process.env.SHEET_ID && (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_FILE));
}

function loadKey() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    || (process.env.GOOGLE_SERVICE_ACCOUNT_FILE && fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
  if (!raw) throw new Error('サービスアカウントの鍵が設定されていません');
  const key = JSON.parse(raw);
  if (!key.client_email || !key.private_key) throw new Error('サービスアカウントの鍵の形式が不正です');
  return key;
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60 * 1000) return cachedToken.token;
  const key = loadKey();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signature = b64url(crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Googleの認証に失敗(HTTP ${res.status}): ${json.error_description || json.error}`);
  cachedToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.token;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Sheets API HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

function rangeUrl(tab, a1, suffix = '') {
  return `${SHEETS_BASE}/${process.env.SHEET_ID}/values/${encodeURIComponent(`'${tab}'!${a1}`)}${suffix}`;
}

async function listTabs() {
  const meta = await api('GET', `${SHEETS_BASE}/${process.env.SHEET_ID}?fields=sheets.properties.title`);
  return (meta.sheets || []).map((s) => s.properties.title);
}

// 不足しているタブとヘッダー行を作る(何度実行しても同じ結果になる)。既存タブの内容は変更しない。
async function ensureTabs() {
  const existing = await listTabs();
  const result = { created: [], headerWritten: [], skipped: [] };

  const missing = TAB_DEFINITIONS.filter((t) => !existing.includes(t.title));
  if (missing.length > 0) {
    await api('POST', `${SHEETS_BASE}/${process.env.SHEET_ID}:batchUpdate`, {
      requests: missing.map((t) => ({
        addSheet: { properties: { title: t.title, gridProperties: { frozenRowCount: 1 } } },
      })),
    });
    result.created = missing.map((t) => t.title);
  }

  for (const tab of TAB_DEFINITIONS) {
    const current = await api('GET', rangeUrl(tab.title, 'A1:A1'));
    const hasHeader = current.values && current.values[0] && current.values[0][0];
    if (hasHeader) {
      result.skipped.push(tab.title);
      continue;
    }
    await api('PUT', rangeUrl(tab.title, 'A1', '?valueInputOption=RAW'), { values: [tab.headers, ...(tab.initialRows || [])] });
    result.headerWritten.push(tab.title);
  }
  return result;
}

function jstString(date = new Date()) {
  const j = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${j.getUTCFullYear()}/${p(j.getUTCMonth() + 1)}/${p(j.getUTCDate())} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`;
}

function runUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : '';
}

// 記録したい行をメモリに積む(実際の書き込みはflush()でまとめて行う)。
// 値は文字列のまま保存される(RAW)ので、19桁のtweet_idも桁落ちしない。
function queue(tab, row) {
  if (!pending.has(tab)) pending.set(tab, []);
  pending.get(tab).push(row);
}

const ERROR_TAB = 'エラー履歴';
const ERROR_DEDUPE_MINUTES = 60;

// 'YYYY/MM/DD HH:mm'(JST)をミリ秒に変換する。解釈できなければ0
function parseJst(s) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/.exec(s || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 9 * 60 * 60 * 1000 : 0;
}

// 同じ処理・同じ内容のエラーが直近60分以内に記録済みなら、重複して積まない
// (投稿が失敗し続けると15分おきの起動のたびに同じ行が増えてしまうため)
async function dropRecentDuplicateErrors(rows) {
  let recent = [];
  try {
    const res = await api('GET', rangeUrl(ERROR_TAB, 'A2:C'));
    recent = (res.values || []).slice(-30);
  } catch (err) {
    return rows;
  }
  const now = Date.now();
  return rows.filter((row) => !recent.some(
    (r) => r[1] === row[1] && r[2] === row[2] && now - parseJst(r[0]) < ERROR_DEDUPE_MINUTES * 60 * 1000
  ));
}

// 積んだ行をタブごとに1回の呼び出しで追記する。失敗しても例外は投げず、ログに残すだけ。
// 戻り値: すべて書き込めた(または書くものがなかった)場合はtrue、1件でも失敗したらfalse
async function flush() {
  if (pending.size === 0) return true;
  if (!isConfigured()) {
    pending.clear();
    return true;
  }
  let allOk = true;
  for (const [tab, queued] of pending) {
    try {
      const rows = tab === ERROR_TAB ? await dropRecentDuplicateErrors(queued) : queued;
      if (rows.length === 0) continue;
      await api('POST', rangeUrl(tab, 'A1', ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS'), { values: rows });
      console.log(`シート記録: ${tab} に${rows.length}行を追記しました。`);
    } catch (err) {
      allOk = false;
      console.error(`シート記録に失敗(${tab}): ${err.message}`);
    }
  }
  pending.clear();
  return allOk;
}

// 範囲の値を読む(空の行は返らない。行末の空セルは省略される)
async function getValues(tab, a1) {
  const res = await api('GET', rangeUrl(tab, a1));
  return res.values || [];
}

// queue/flushを通さず、その場で追記する(フォロー等、1件ごとに確実に記録したい処理用)
async function appendNow(tab, rows, a1 = 'A1') {
  if (rows.length === 0) return;
  await api('POST', rangeUrl(tab, a1, ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS'), { values: rows });
}

// 複数の範囲をまとめて更新する。updates: [{ tab, a1, values }]
async function updateValues(updates) {
  if (updates.length === 0) return;
  await api('POST', `${SHEETS_BASE}/${process.env.SHEET_ID}/values:batchUpdate`, {
    valueInputOption: 'RAW',
    data: updates.map((u) => ({ range: `'${u.tab}'!${u.a1}`, values: u.values })),
  });
}

module.exports = {
  isConfigured, listTabs, ensureTabs, queue, flush, jstString, runUrl, api, rangeUrl,
  getValues, appendNow, updateValues, TAB_DEFINITIONS,
};
