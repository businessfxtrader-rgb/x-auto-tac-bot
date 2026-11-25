// 自動フォロバ・フォロー解除(TAC_FXtrade)
//
// 仕様:
//   - フォローは1日5件まで、解除は1日5件まで(設定タブで変更可)
//   - フォロー対象: 先着順。鍵アカウント・アカウント作成から1か月以内の相手は除外
//   - 解除対象: Botがフォロバした相手のうち、フォロワー一覧から消えた人だけ(手動でフォローした相手は触らない)
//   - フォロー・解除でエラーが出たら、その日は自動で止める
//   - 月予算ガード: 概算費用がXの請求サイクル(毎月11日開始)で上限に達したら止める
//   - フォロワー一覧の全件読み取りは月1回(費用はフォロワー数に比例するため)
//
// ログには、ユーザーID・ユーザー名を一切出さない(公開リポジトリのActionsログは誰でも見られるため)。
// 個人情報は、非公開の管理シート(フォロバ履歴 / フォロバ候補)にだけ置く。
//
// 使い方:
//   node follow.js --plan   確認モード。必要なら一覧を読んで候補を更新するが、フォロー・解除はしない
//   node follow.js          設定タブの「フォロバ自動化」がONのときだけ、1日1回(10:00 JST以降)実行する

const fs = require('fs');
const path = require('path');
const { apiGet, apiPostJson, apiDelete, loadConfig } = require('./oauth-lib');
const sheet = require('./sheet');

const config = loadConfig();
const X_API = 'https://api.twitter.com/2';
const STATE_FILE = path.join(__dirname, 'follow-state.json');

const RUN_AT_MINUTES_JST = 10 * 60;
const FULL_READ_INTERVAL_DAYS = 30;
const MAX_PAGES = 30;
const MAX_ATTEMPTS = 3;
const SEED_SIZE = 200;
const FOLLOW_PRICE = 0.015;
const UNFOLLOW_PRICE = 0.010;

const TAB = { history: 'フォロバ履歴', queue: 'フォロバ候補', usage: 'API利用', settings: '設定' };
const KIND = { follow: 'フォロバ待ち', unfollow: '解除待ち' };
// フォロバ候補タブの列(0始まり): ID, ユーザー名, 種別, 作成日, 初回確認日, 状態, 試行回数, 鍵, メモ
const Q = { id: 0, name: 1, kind: 2, created: 3, seen: 4, status: 5, attempts: 6, locked: 7, memo: 8 };
const QUEUE_COLS = 9;

// ---------- 日付・設定まわりの部品(通信なし) ----------

const nowJst = () => new Date(Date.now() + 9 * 60 * 60 * 1000);
const todayStr = () => nowJst().toISOString().slice(0, 10);
const round = (n) => Math.round(n * 10000) / 10000;

// Xの請求サイクルの開始日(毎月11日)
function cycleStartOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (d >= 11) return `${y}-${String(m).padStart(2, '0')}-11`;
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  return `${py}-${String(pm).padStart(2, '0')}-11`;
}

function daysBetween(fromDateStr, toDateStr) {
  return (Date.parse(`${toDateStr}T00:00:00Z`) - Date.parse(`${fromDateStr}T00:00:00Z`)) / 86400000;
}

function parseSettings(rows) {
  const m = new Map(rows.map((r) => [String(r[0] || '').trim(), r[1]]));
  const num = (key, fallback) => {
    const raw = m.get(key);
    const v = Number(raw);
    return raw === undefined || raw === '' || !Number.isFinite(v) ? fallback : v;
  };
  return {
    enabled: String(m.get('フォロバ自動化') || '').trim().toUpperCase() === 'ON',
    followCap: num('フォロー上限(件/日)', 5),
    unfollowCap: num('解除上限(件/日)', 5),
    budgetGuard: num('月予算ガード($/サイクル)', 5),
    minAgeDays: num('アカウント作成からの最低日数', 30),
    readPrice: num('フォロワー読取単価($/件)', 0.01),
    fullReadEnabled: String(m.get('一覧の全件読み取り') || '').trim().toUpperCase() === 'ON',
  };
}

function cycleCostSoFar(usageRows, cycleStart) {
  return usageRows.filter((r) => r[4] === cycleStart).reduce((sum, r) => sum + (Number(r[3]) || 0), 0);
}

const padRow = (r, n) => Array.from({ length: n }, (_, i) => (r[i] === undefined ? '' : r[i]));

// ---------- 判定ロジック(通信なし。テスト対象) ----------

// フォロワー一覧が「古い順」か「新しい順」かを、相互フォロー済みの人の位置の偏りから推定する
function detectListOrder(followers) {
  const idx = [];
  followers.forEach((u, i) => { if ((u.connection_status || []).includes('following')) idx.push(i); });
  if (idx.length < 5 || followers.length < 50) return { order: 'unknown', ratio: null };
  const ratio = idx.reduce((a, b) => a + b, 0) / idx.length / followers.length; // 0〜1(小さいほど先頭寄り)
  return { order: ratio < 0.4 ? 'oldest-first' : ratio > 0.6 ? 'newest-first' : 'unknown', ratio: round(ratio) };
}

// 先頭の一部だけ読んだ場合の並び推定: 相互フォローの人が先頭に多ければ「古い順」とみなす
function detectHeadOrder(sample, followingCount, followersCount) {
  if (sample.length < 50) return { order: 'unknown', share: null };
  const mutual = sample.filter((u) => (u.connection_status || []).includes('following')).length;
  const share = mutual / sample.length;
  const base = followersCount > 0 ? Math.min(1, (followingCount || 0) / followersCount) : 0;
  // 全体の相互率(base)が高いと偏りは判別できないので unknown のままにする
  return { order: base <= 0.6 && share >= Math.max(0.1, base * 1.5) ? 'oldest-first' : 'unknown', share: round(share) };
}

// 履歴から、ユーザーごとの「最新の成功した処理」を求める
function latestSuccessByUser(historyRows) {
  const map = new Map();
  for (const r of historyRows) {
    if (String(r[4] || '').startsWith('成功')) map.set(String(r[0]), { status: r[2], name: r[1] });
  }
  return map;
}

// フォロワー一覧と既存の候補・履歴から、候補タブへの追記行と更新内容を決める
function planRefresh({ followers, followersCount, queueRows, historyRows, listOrder, today, partial = false }) {
  const stats = {
    followers: followers.length, newCandidates: 0, lockedMarked: 0, alreadyFollowing: 0,
    requestPending: 0, markedManual: 0, markedGone: 0, newUnfollow: 0, unfollowSkippedByGuard: false,
  };
  const ordered = listOrder === 'newest-first' ? [...followers].reverse() : followers;
  const followerIds = new Set(followers.map((u) => String(u.id)));
  const byKey = new Map();
  queueRows.forEach((r, i) => byKey.set(`${r[Q.kind]}|${r[Q.id]}`, { row: r, index: i }));

  const appendRows = [];
  const updates = []; // { index(0始まり), status }

  for (const u of ordered) {
    const cs = u.connection_status || [];
    const existing = byKey.get(`${KIND.follow}|${u.id}`);
    if (cs.includes('following')) {
      stats.alreadyFollowing++;
      if (existing && existing.row[Q.status] === '待機') { updates.push({ index: existing.index, status: '済(手動)' }); stats.markedManual++; }
      continue;
    }
    if (cs.includes('follow_request_sent')) { stats.requestPending++; continue; }
    if (existing) continue;
    const locked = !!u.protected;
    if (locked) stats.lockedMarked++;
    stats.newCandidates++;
    appendRows.push([
      String(u.id), u.username || '', KIND.follow, (u.created_at || '').slice(0, 10), today,
      locked ? '対象外' : '待機', 0, locked ? 'Y' : 'N', locked ? '鍵アカウント' : '',
    ]);
  }

  // 先にフォロバ待ちになっていたが、相手がフォローを外した人は対象外にする
  // (一部だけ読んだ場合は、一覧に居ない=離脱とは言えないので何もしない)
  for (const { row, index } of partial ? [] : byKey.values()) {
    if (row[Q.kind] === KIND.follow && row[Q.status] === '待機' && !followerIds.has(String(row[Q.id]))) {
      updates.push({ index, status: '対象外(離脱)' }); stats.markedGone++;
    }
  }

  // フォロー解除の候補: Botがフォロバした相手のうち、フォロワー一覧から消えた人
  const guardGap = Math.max(10, Math.ceil((followersCount || 0) * 0.05));
  if (partial || (followersCount || 0) - followers.length > guardGap) {
    stats.unfollowSkippedByGuard = true; // 取得できた人数が、プロフィールの人数より大幅に少ない: 一覧が欠けている恐れ
  } else {
    for (const [id, info] of latestSuccessByUser(historyRows)) {
      if (info.status !== 'フォロバ' || followerIds.has(id)) continue;
      if (byKey.has(`${KIND.unfollow}|${id}`)) continue;
      stats.newUnfollow++;
      appendRows.push([id, info.name || '', KIND.unfollow, '', today, '待機', 0, '', '']);
    }
  }
  // 解除待ちだったが、相手が再びフォローしてきた場合は取り消す
  for (const { row, index } of byKey.values()) {
    if (row[Q.kind] === KIND.unfollow && row[Q.status] === '待機' && followerIds.has(String(row[Q.id]))) {
      updates.push({ index, status: '対象外(再フォロー)' });
    }
  }
  return { appendRows, updates, stats };
}

// 今日フォロバする相手(先着順 = 候補タブの上から順)
function pickFollowTargets(queueRows, { minAgeDays, limit, today }) {
  const out = [];
  queueRows.forEach((r, i) => {
    if (out.length >= limit) return;
    if (r[Q.kind] !== KIND.follow || r[Q.status] !== '待機' || r[Q.locked] === 'Y') return;
    if ((Number(r[Q.attempts]) || 0) >= MAX_ATTEMPTS) return;
    const created = String(r[Q.created] || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(created)) return; // 作成日が不明な相手は、安全のため対象外
    if (daysBetween(created, today) < minAgeDays) return;
    out.push({ index: i, row: r });
  });
  return out;
}

function pickUnfollowTargets(queueRows, { limit }) {
  const out = [];
  queueRows.forEach((r, i) => {
    if (out.length >= limit) return;
    if (r[Q.kind] !== KIND.unfollow || r[Q.status] !== '待機') return;
    if ((Number(r[Q.attempts]) || 0) >= MAX_ATTEMPTS) return;
    out.push({ index: i, row: r });
  });
  return out;
}

// 履歴(D列は'YYYY/MM/DD HH:mm')から、今日の件数と失敗の有無を数える
function summarizeToday(historyRows, todaySlash) {
  const s = { follows: 0, unfollows: 0, failed: false };
  for (const r of historyRows) {
    if (!String(r[3] || '').startsWith(todaySlash)) continue;
    const ok = String(r[4] || '').startsWith('成功');
    if (ok && r[2] === 'フォロバ') s.follows++;
    else if (ok && r[2] === '解除') s.unfollows++;
    else if (!ok) s.failed = true;
  }
  return s;
}

// ---------- 状態ファイル・通信まわり ----------

function loadState() {
  try {
    return { lastRunDate: null, lastFullReadDate: null, seededDate: null, listOrder: 'unknown', stoppedDate: null, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch (err) {
    return { lastRunDate: null, lastFullReadDate: null, seededDate: null, listOrder: 'unknown', stoppedDate: null };
  }
}
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ログに出す文字列から、長い数字(ユーザーID等)を伏せる
const mask = (s) => String(s).replace(/\d{6,}/g, '[ID]');

async function fetchAllFollowers(myId, token, secret) {
  const users = [];
  let next;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = { max_results: '1000', 'user.fields': 'username,protected,created_at,connection_status' };
    if (next) params.pagination_token = next;
    const res = await apiGet(`${X_API}/users/${myId}/followers`, params, token, secret);
    users.push(...(res.data || []));
    next = res.meta && res.meta.next_token;
    if (!next) return users;
  }
  throw new Error(`フォロワー一覧が${MAX_PAGES}ページを超えたため中止しました`);
}

// ---------- 本体 ----------

async function main() {
  const planOnly = process.argv.includes('--plan');
  if (!sheet.isConfigured()) { console.log('シートが未設定のため何もしません。'); return; }

  const token = config.posterAccessToken;
  const secret = config.posterAccessSecret;
  const myId = token.split('-')[0];
  const state = loadState();
  const today = todayStr();
  const todaySlash = today.replace(/-/g, '/');
  const now = nowJst();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  const settings = parseSettings(await sheet.getValues(TAB.settings, 'A2:B30'));

  if (!planOnly) {
    if (!settings.enabled) { console.log('フォロバ自動化はOFF(設定タブ)のため、何もしません。'); return; }
    if (state.lastRunDate === today) { console.log('本日分は実行済みのためスキップします。'); return; }
    if (state.stoppedDate === today) { console.log('本日はエラーのため停止中です。'); return; }
    if (minutes < RUN_AT_MINUTES_JST) { console.log('10:00 JST前のためスキップします。'); return; }
  }

  const historyRows = await sheet.getValues(TAB.history, 'A2:E');
  const usageRows = await sheet.getValues(TAB.usage, 'A2:E');
  const cycle = cycleStartOf(today);
  let spent = cycleCostSoFar(usageRows, cycle);
  const canSpend = (amount) => spent + amount <= settings.budgetGuard + 1e-9;
  const used = { read: 0, follow: 0, unfollow: 0 };

  // 失敗が今日すでに記録されている場合は、何もせず止める(状態ファイルが保存されなかった場合の保険)
  const todaySummary = summarizeToday(historyRows, todaySlash);
  if (!planOnly && todaySummary.failed) {
    state.stoppedDate = today; saveState(state);
    console.log('本日はすでにエラーが記録されているため停止します。');
    return;
  }

  // 1) フォロワー一覧の読み取り(費用が最も大きい処理)
  //    - 全件読み取り: 設定タブ「一覧の全件読み取り」がONのとき、月1回
  //    - 初回の部分読み取り: 先頭200人だけ。読取単価が確認できるまではこれだけ行う
  const readToday = usageRows.some((r) => r[0] === today && String(r[1]).startsWith('一覧読取'));
  const fullDue = !state.lastFullReadDate || daysBetween(state.lastFullReadDate, today) >= FULL_READ_INTERVAL_DAYS;
  const seedDue = !state.seededDate && !state.lastFullReadDate;
  if (!readToday && ((settings.fullReadEnabled && fullDue) || (!settings.fullReadEnabled && seedDue))) {
    const partial = !settings.fullReadEnabled;
    const me = await apiGet(`${X_API}/users/me`, { 'user.fields': 'public_metrics' }, token, secret);
    const followersCount = me.data.public_metrics.followers_count;
    const followingCount = me.data.public_metrics.following_count;
    const expected = ((partial ? Math.min(SEED_SIZE, followersCount) : followersCount) + 1) * settings.readPrice;
    if (!canSpend(expected)) {
      throw new Error(`予算ガード: 一覧読取の見込み費用($${expected.toFixed(2)})を加えると上限($${settings.budgetGuard})を超えるため中止しました`);
    }
    let followers;
    if (partial) {
      const res = await apiGet(`${X_API}/users/${myId}/followers`,
        { max_results: String(SEED_SIZE), 'user.fields': 'username,protected,created_at,connection_status' }, token, secret);
      followers = res.data || [];
    } else {
      followers = await fetchAllFollowers(myId, token, secret);
    }
    const readCost = round((followers.length + 1) * settings.readPrice);
    await sheet.appendNow(TAB.usage, [[today, partial ? '一覧読取(先頭のみ)' : '一覧読取', followers.length + 1, readCost, cycle]]);
    spent += readCost;

    const detected = partial ? detectHeadOrder(followers, followingCount, followersCount) : detectListOrder(followers);
    if (detected.order !== 'unknown') state.listOrder = detected.order;
    console.log(`フォロワー一覧を取得: ${followers.length}人${partial ? '(先頭のみ)' : ''}(一覧の並び推定: ${detected.order}, ${partial ? '相互の割合' : '位置の偏り'}: ${partial ? detected.share : detected.ratio})`);

    const queueNow = (await sheet.getValues(TAB.queue, 'A2:I')).map((r) => padRow(r, QUEUE_COLS));
    const plan = planRefresh({ followers, followersCount, queueRows: queueNow, historyRows, listOrder: state.listOrder, today, partial });
    await sheet.appendNow(TAB.queue, plan.appendRows);
    await sheet.updateValues(plan.updates.map((u) => ({ tab: TAB.queue, a1: `F${u.index + 2}`, values: [[u.status]] })));
    if (partial) state.seededDate = today; else state.lastFullReadDate = today;
    saveState(state);
    console.log('候補の更新:', JSON.stringify(plan.stats));
  }

  if (planOnly) {
    const queue = (await sheet.getValues(TAB.queue, 'A2:I')).map((r) => padRow(r, QUEUE_COLS));
    const eligible = pickFollowTargets(queue, { minAgeDays: settings.minAgeDays, limit: Infinity, today }).length;
    const waiting = queue.filter((r) => r[Q.kind] === KIND.follow && r[Q.status] === '待機').length;
    console.log(`確認モード: フォロバ待ち${waiting}人のうち、今日フォローできる条件を満たす人は${eligible}人(1日の上限${settings.followCap}件)`);
    console.log(`解除待ち: ${queue.filter((r) => r[Q.kind] === KIND.unfollow && r[Q.status] === '待機').length}人 / 当サイクルの概算費用: $${spent.toFixed(3)}(上限$${settings.budgetGuard})`);
    return;
  }

  // 2) フォロバ・解除の実行
  const queue = (await sheet.getValues(TAB.queue, 'A2:I')).map((r) => padRow(r, QUEUE_COLS));
  let halted = null; // { reason: 'error' | 'guard' }

  async function act(target, { kind, price, call }) {
    if (!canSpend(price)) { halted = { reason: 'guard' }; return false; }
    const r = target.row;
    const attempts = (Number(r[Q.attempts]) || 0) + 1;
    let result;
    let ok = false;
    try {
      result = await call(String(r[Q.id]));
      ok = true;
    } catch (err) {
      result = `失敗:${String(err.message).slice(0, 200)}`;
    }
    spent += price;
    used[kind === 'フォロバ' ? 'follow' : 'unfollow']++;
    await sheet.appendNow(TAB.history, [[String(r[Q.id]), r[Q.name], kind, sheet.jstString(), result]], 'A:E');
    const status = ok ? '済' : attempts >= MAX_ATTEMPTS ? '失敗停止' : '待機';
    await sheet.updateValues([{ tab: TAB.queue, a1: `F${target.index + 2}:G${target.index + 2}`, values: [[status, attempts]] }]);
    if (!ok) {
      sheet.queue('エラー履歴', [sheet.jstString(), 'フォロバ', result, sheet.runUrl()]);
      halted = { reason: 'error' };
      return false;
    }
    await sleep(3000 + Math.floor(Math.random() * 5000));
    return true;
  }

  const followTargets = pickFollowTargets(queue, { minAgeDays: settings.minAgeDays, limit: settings.followCap - todaySummary.follows, today });
  for (const t of followTargets) {
    const ok = await act(t, {
      kind: 'フォロバ', price: FOLLOW_PRICE,
      call: async (id) => {
        const res = await apiPostJson(`${X_API}/users/${myId}/following`, { target_user_id: id }, token, secret);
        const d = res.data || {};
        if (d.following === true) return '成功';
        if (d.pending_follow === true) return '成功(承認待ち)';
        throw new Error('要確認: 想定外の応答です');
      },
    });
    if (!ok) break;
  }

  if (!halted) {
    const unfollowTargets = pickUnfollowTargets(queue, { limit: settings.unfollowCap - todaySummary.unfollows });
    for (const t of unfollowTargets) {
      const ok = await act(t, {
        kind: '解除', price: UNFOLLOW_PRICE,
        call: async (id) => {
          const res = await apiDelete(`${X_API}/users/${myId}/following/${id}`, token, secret);
          if ((res.data || {}).following === false) return '成功';
          throw new Error('要確認: 想定外の応答です');
        },
      });
      if (!ok) break;
    }
  }

  // 3) 費用の記録と状態の保存
  const usageOut = [];
  if (used.follow) usageOut.push([today, 'フォロー', used.follow, round(used.follow * FOLLOW_PRICE), cycle]);
  if (used.unfollow) usageOut.push([today, '解除', used.unfollow, round(used.unfollow * UNFOLLOW_PRICE), cycle]);
  await sheet.appendNow(TAB.usage, usageOut);

  if (halted && halted.reason === 'guard') {
    sheet.queue('エラー履歴', [sheet.jstString(), 'フォロバ', `予算ガード: 当サイクルの概算費用が上限($${settings.budgetGuard})に達したため停止`, sheet.runUrl()]);
  }
  if (halted && halted.reason === 'error') state.stoppedDate = today;
  state.lastRunDate = today;
  saveState(state);
  console.log(`実行結果: フォロー${used.follow}件 / 解除${used.unfollow}件${halted ? `(${halted.reason === 'error' ? 'エラーのため停止' : '予算ガードのため停止'})` : ''} / 当サイクルの概算費用 $${spent.toFixed(3)}`);
}

module.exports = {
  cycleStartOf, daysBetween, parseSettings, cycleCostSoFar, detectListOrder, latestSuccessByUser,
  detectHeadOrder, planRefresh, pickFollowTargets, pickUnfollowTargets, summarizeToday, mask,
};

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('エラー:', mask(err.message));
      sheet.queue('エラー履歴', [sheet.jstString(), 'フォロバ', String(err.message).slice(0, 300), sheet.runUrl()]);
      process.exitCode = 1;
    })
    .then(() => sheet.flush());
}
