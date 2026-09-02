// TAC_FXtrade 自動投稿ボット
// Claude Code CLI(サブスクリプション認証、追加API課金なし)で投稿文を生成し、
// そのままXに投稿する(完全自動)。
// 事前に `claude setup-token` で取得したトークンを環境変数
// CLAUDE_CODE_OAUTH_TOKEN に設定しておく必要がある。
// 使い方:
//   node tac-post.js --dry-run   生成のみ行い、投稿はしない(動作確認用)
//   node tac-post.js             実際に投稿する

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { apiPostJson, apiGet, loadConfig } = require('./oauth-lib');

const config = loadConfig();
const STATE_FILE = path.join(__dirname, 'state.json');
const X_API_BASE = 'https://api.twitter.com/2';

// 1日に投稿してよい最大回数(暴走・設定ミスによる予算超過を防ぐ安全弁)
const MAX_POSTS_PER_DAY = 3;

// 投稿時間帯(JST、分単位で表現。固定2枠: 7:30 と 19:00)
const CANDIDATE_SLOTS_JST = [7 * 60 + 30, 19 * 60];
const POSTS_PER_DAY_TARGET = 2;
const EPSILON = 0.25; // 切り口(FORMATS)選定でこの確率でランダムな(まだ実績の薄い)ものを試す

function formatSlot(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}
const METRICS_DELAY_HOURS = 24; // 投稿からこれだけ経過したらインプレッションを取得
const METRICS_GIVEUP_HOURS = 24 * 4; // これ以上経っても取得できなければ諦める

// 「今伸びているツイート」の分析キャッシュ設定
// (X検索APIは有料なので、数日おきの更新に留めてコストを抑える。使う頻度が上がってもキャッシュのおかげでコストは増えない)
const TREND_CACHE_VALID_DAYS = 3;
const FX_TREND_SEARCH_QUERY = '(FX OR 為替 OR ドル円 OR 投資 OR トレード) lang:ja -is:retweet -is:reply';
// min_faves等のエンゲージメント演算子はPay-Per-Useプランでは使用不可のため、
// 共感・バズ系ツイートに出やすいキーワードで代用する
const VIRAL_TREND_SEARCH_QUERY = '(あるある OR わかる OR 共感 OR これは伸びる) lang:ja -is:retweet -is:reply';

const CATEGORIES = [
  { id: 'market_news', label: '市場ニュース・相場コメント', weight: 3, needsSearch: true },
  { id: 'fx_basics', label: 'FX・為替の基礎知識/豆知識', weight: 3, needsSearch: false },
  { id: 'celebrity_story', label: '芸能人の投資・お金にまつわるエピソード', weight: 1, needsSearch: true },
  { id: 'video_recap', label: '過去動画の要約・再紹介', weight: 2, needsSearch: false },
];

// 投稿の「切り口・構成」のバリエーション。話題(CATEGORIES)とは独立した軸で、
// どの切り口がインプレッションを稼ぎやすいかもε-greedyで学習していく。
const FORMATS = [
  { id: 'question_hook', label: '問いかけから始める', instruction: '冒頭を読者への問いかけ(「〜って知ってました?」等)から始めてください。' },
  { id: 'surprising_fact', label: '意外な事実・数字から入る', instruction: '冒頭を意外性のある事実や数字から始めてください(創作せず、確認できる事実の範囲で)。' },
  { id: 'story_lead', label: 'エピソード風', instruction: 'ちょっとした体験談・エピソードを語るような書き出しにしてください。' },
  { id: 'listicle', label: '箇条書き整理風', instruction: '「ポイントは○つ」のように、要点を整理して伝える構成にしてください(絵文字の番号や記号を使ってもよい)。' },
  { id: 'casual_chat', label: '雑談・つぶやき風', instruction: '独り言やつぶやきのような、力の抜けた自然な語り口にしてください。' },
  { id: 'direct_tip', label: '結論ファースト', instruction: '結論やアドバイスを最初に言い切ってから、理由や補足を続ける構成にしてください。' },
  { id: 'punchline', label: '短い一言パンチライン', instruction: '説明を省き、全角20〜40文字程度の短く言い切る一言だけにしてください。インパクト重視で、共感や「わかる」を誘う一文にしてください。' },
];

// 断定的な投資助言・利回り保証と受け取られる表現(検出したら投稿しない)
const BANNED_PATTERNS = [
  /絶対に?儲か/, /確実に儲か/, /必ず儲か/, /元本保証/, /損しない/,
  /必ず勝て/, /100%/, /ノーリスク/, /絶対に?上が/, /絶対に?下が/,
  /今すぐ買う?べき/, /今すぐ売る?べき/,
];

function loadState() {
  const defaults = {
    recentCategories: [],
    lastVideoId: null,
    dailyPostCount: { date: null, count: 0 },
    slotStats: {},
    formatStats: {},
    recentFormats: [],
    todaysPlan: { date: null, slots: [] },
    pendingMetrics: [],
    fxTrendCache: { date: null, examples: [] },
    viralTrendCache: { date: null, examples: [] },
  };
  if (!fs.existsSync(STATE_FILE)) return defaults;
  return { ...defaults, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function nowJst() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function todayJst() {
  return nowJst().toISOString().slice(0, 10);
}

function currentSlotMinutesJst() {
  const d = nowJst();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// 今日投稿する時間帯を、実績に基づくε-greedy方式で選ぶ(1日1回だけ計算し、当日はstateに固定する)
function buildTodaysPlan(slotStats) {
  const chosen = [];
  const remaining = [...CANDIDATE_SLOTS_JST];

  function avgImpressions(slot) {
    const s = slotStats[slot];
    if (!s || s.trials === 0) return null;
    return s.totalImpressions / s.trials;
  }

  for (let i = 0; i < POSTS_PER_DAY_TARGET && remaining.length > 0; i++) {
    const untried = remaining.filter((s) => avgImpressions(s) === null);
    let pick;
    if (untried.length > 0) {
      // 実績が無い時間帯を優先的に試す(探索の土台作り)
      pick = untried[Math.floor(Math.random() * untried.length)];
    } else if (Math.random() < EPSILON) {
      pick = remaining[Math.floor(Math.random() * remaining.length)];
    } else {
      pick = remaining.reduce((best, s) => (avgImpressions(s) > avgImpressions(best) ? s : best), remaining[0]);
    }
    chosen.push(pick);
    remaining.splice(remaining.indexOf(pick), 1);
  }
  return chosen.sort((a, b) => a - b);
}

function ensureTodaysPlan(state) {
  const today = todayJst();
  if (state.todaysPlan.date !== today) {
    state.todaysPlan = { date: today, slots: buildTodaysPlan(state.slotStats) };
    console.log(`本日の投稿予定時間帯(JST): ${state.todaysPlan.slots.map(formatSlot).join(', ')}`);
  }
  return state.todaysPlan;
}

async function fetchYoutubeFeed() {
  const channelId = config.youtubeChannelId;
  if (!channelId) return [];
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  if (!res.ok) return [];
  const xml = await res.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  return entries.map((entry) => {
    const videoId = (entry.match(/<yt:videoId>(.*?)<\/yt:videoId>/) || [])[1];
    const title = (entry.match(/<title>(.*?)<\/title>/) || [])[1];
    return { videoId, title, url: `https://www.youtube.com/watch?v=${videoId}` };
  }).filter((v) => v.videoId && v.title);
}

// チャンネルにはFX・投資と無関係な動画(雑談・エンタメ系など)も混ざっているため、
// 過去動画の再紹介ではタイトルにFX・投資関連キーワードを含むものだけを対象にする
const FX_RELATED_KEYWORDS = ['FX', '為替', 'ドル', '円', 'トレード', 'チャート', '投資', '相場', 'テクニカル', '通貨', '口座', 'エントリー'];

function filterFxRelated(videos) {
  return videos.filter((v) => FX_RELATED_KEYWORDS.some((kw) => v.title.includes(kw)));
}

// Xの検索APIで指定クエリのツイートを取得し、いいね+リツイート数の合計が多い順に上位を返す
async function fetchTweetsBySearch(query) {
  try {
    const res = await apiGet(
      `${X_API_BASE}/tweets/search/recent`,
      { query, max_results: '10', 'tweet.fields': 'public_metrics' },
      config.posterAccessToken,
      config.posterAccessSecret
    );
    const tweets = res.data || [];
    return tweets
      .map((t) => ({
        text: t.text,
        engagement: (t.public_metrics.like_count || 0) + (t.public_metrics.retweet_count || 0),
      }))
      .sort((a, b) => b.engagement - a.engagement)
      .slice(0, 5);
  } catch (err) {
    console.error(`ツイート検索に失敗(${query}): ${err.message}`);
    return [];
  }
}

// 汎用のキャッシュ更新ヘルパー(dateフィールドとexamplesフィールドを持つキャッシュオブジェクトを更新する)
async function ensureCache(state, cacheKey, validDays, fetcher, label) {
  const today = todayJst();
  const cache = state[cacheKey];
  const daysSinceCache = cache.date
    ? (new Date(today) - new Date(cache.date)) / (24 * 60 * 60 * 1000)
    : Infinity;
  if (daysSinceCache < validDays) return cache.examples;

  const examples = await fetcher();
  if (examples.length > 0) {
    state[cacheKey] = { date: today, examples };
    console.log(`${label}キャッシュを更新しました(${examples.length}件)`);
  }
  return state[cacheKey].examples;
}

function pickCategory(recentCategories, hasNewVideo) {
  if (hasNewVideo) return 'video_announcement';
  const pool = CATEGORIES.filter((c) => !recentCategories.slice(-1).includes(c.id));
  const total = pool.reduce((sum, c) => sum + c.weight, 0);
  let r = Math.random() * total;
  for (const c of pool) {
    if (r < c.weight) return c.id;
    r -= c.weight;
  }
  return pool[0].id;
}

// 投稿の切り口(FORMATS)をε-greedyで選ぶ。実績の良い切り口を優先しつつ、
// 直近2回と同じ切り口は避けて、常にバリエーションが出るようにする。
function pickFormat(formatStats, recentFormats) {
  const pool = FORMATS.filter((f) => !(recentFormats || []).slice(-2).includes(f.id));

  function avgImpressions(f) {
    const s = formatStats[f.id];
    if (!s || s.trials === 0) return null;
    return s.totalImpressions / s.trials;
  }

  const untried = pool.filter((f) => avgImpressions(f) === null);
  if (untried.length > 0) {
    return untried[Math.floor(Math.random() * untried.length)].id;
  }
  if (Math.random() < EPSILON) {
    return pool[Math.floor(Math.random() * pool.length)].id;
  }
  return pool.reduce((best, f) => (avgImpressions(f) > avgImpressions(best) ? f : best), pool[0]).id;
}

function exampleList(examples) {
  return examples.map((e, i) => `${i + 1}. 「${e.text.replace(/\n/g, ' ')}」`).join('\n');
}

function buildPrompt(categoryId, context, formatId, trendExamples, viralExamples) {
  const base = `あなたはFX・投資系YouTubeチャンネル「TAC投資チャンネル」の公式X(Twitter)アカウント運用担当です。
以下の制約を厳守して、日本語のツイート文を1つだけ生成してください。

【文体】
- カジュアルで親しみやすい口調(堅すぎる敬語や専門用語の羅列は避ける)
- 絵文字は多用しすぎない(0〜2個程度)
- AI(ChatGPTなど)が書いたような不自然さを消すこと。具体的には:
  - Markdown記法(太字・見出し・箇条書き記号)は使わない(絵文字の番号や記号での整理は可)
  - 「」や()の多用を避ける。コロン「:」も使わない
  - 「以下で解説します」「〜という視点で見ていきましょう」のような構成を宣言する前置きを書かない
  - 「参考になれば幸いです」のようなテンプレ的な締めの一文を使わない
  - 「一概には言えませんが」「場合によります」「一般的に」「多くの場合」「状況によって異なります」のような、判断を全部読者に丸投げする保険文句・ぼかし表現を使わない
  - 「重要」「効果的」「本質」「価値」のような抽象的な万能語に逃げず、具体的に何がどうなのかを書く
  - 同じ文末表現を連続させない。短文と長文を意図的に混ぜる
  - 羅針盤・地図・土台・エンジンのような、比喩として使い古された表現を避ける

【断定と言い切りについて】
プロフィール欄に「投資助言ではない」旨の免責はすでに記載済みなので、投稿本文で毎回保険をかける必要はない。
「絶対儲かる」「確実に上がる/下がる」のような利益保証・断定的な投資助言はNGだが、それ以外の自分の見方・意見・感想ははっきり言い切ってよい。
ぼかしすぎて当たり障りのない内容にすると誰にも刺さらないので、避けること。

【厳守事項】
- 文字数は内容と切り口に合わせて自由でよい(全角100〜120文字程度が基本の目安だが、短い一言でインパクトを出す切り口なら全角20〜40文字程度でも構わない。逆に長くても全角130文字程度までに収める)
- 「絶対に儲かる」「確実に儲かる」「元本保証」「必ず勝てる」など、利益や結果を保証する断定表現は一切使わない(相場観や意見の言い切りはOK)
- 特定の売買を推奨する表現(「今すぐ買うべき」等)は使わない
- 事実に基づかない具体的な数値(価格・指標の値など)を創作しない。不確かな場合は数値を出さずに、自分の見立てとして言い切る
- 出力はツイート本文のみ。説明や前置き、引用符は不要`;

  const perCategory = {
    market_news: `
【今回のテーマ】直近の為替・金融市場に関する時事ネタや、経済指標・要人発言についてのコメント。
必要であればWeb検索ツールで直近の実際のニュースを確認し、それに基づいて書いてください。検索結果が得られない場合は、特定の数値や断定を避け、一般的な視点・考え方の話に切り替えてください。`,
    fx_basics: `
【今回のテーマ】FX・為替に関する基礎知識や豆知識を、初心者にも分かりやすく1つ紹介してください。`,
    celebrity_story: `
【今回のテーマ】芸能人・著名人の投資やお金にまつわる、広く報道された事実に基づくエピソードを1つ紹介してください。
必ずWeb検索ツールで事実関係を確認してから書いてください。裏取りできない噂話や未確認情報は扱わないこと。個人への誹謗中傷や決めつけにならないよう、事実の紹介にとどめ、断定的な評価は避けてください。`,
    video_recap: `
【今回のテーマ】以下のチャンネル過去動画を、見ていない人が興味を持つように、ネタバレしすぎない範囲で軽く紹介してください。動画タイトル: 「${context.videoTitle || 'FX初心者向け解説動画'}」
URLやチャンネルへの誘導文は入れないでください(本文のみ)。`,
    video_announcement: `
【今回のテーマ】YouTubeチャンネルに新しい動画がアップされました。視聴を呼びかける告知ツイートを書いてください。
動画タイトル: 「${context.videoTitle}」
最後に必ずこのURLを含めてください: ${context.videoUrl}`,
  };

  const format = FORMATS.find((f) => f.id === formatId);
  const formatInstruction = format ? `\n【今回の切り口】${format.instruction}` : '';

  let referenceSection = '';
  const refParts = [];
  if (trendExamples && trendExamples.length > 0) {
    refParts.push(`今、X上でFX/金融ジャンルで反応が多いツイートの例:\n${exampleList(trendExamples)}`);
  }
  if (viralExamples && viralExamples.length > 0) {
    refParts.push(`ジャンルを問わず今バズっているツイートの例(文体・テンポの参考):\n${exampleList(viralExamples)}`);
  }
  if (refParts.length > 0) {
    referenceSection = `
【参考ツイート】
${refParts.join('\n\n')}
これらの文章や表現をそのままコピーせず、なぜ反応を得られていそうか(切り口・テンポ・共感ポイントなど)を分析し、その学びだけを今回の投稿に活かしてください。`;
  }

  return base + '\n' + (perCategory[categoryId] || '') + formatInstruction + referenceSection;
}

// Claude Code CLI(サブスクリプション認証)を非対話モードで呼び出し、投稿文を1つ生成する。
// ファイル操作・コマンド実行系のツールは明示的に禁止し、必要な場合のみWebSearchのみ許可する。
async function generateTweet(categoryId, context, formatId, trendExamples, viralExamples) {
  const category = CATEGORIES.find((c) => c.id === categoryId) || { needsSearch: categoryId === 'video_announcement' ? false : true };
  const systemPrompt = buildPrompt(categoryId, context, formatId, trendExamples, viralExamples);

  const promptFile = path.join(os.tmpdir(), `tac-system-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(promptFile, systemPrompt, 'utf8');

  const args = [
    '-p', 'ツイート文を生成してください。',
    '--system-prompt-file', promptFile,
    '--disallowedTools', 'Bash,Edit,Write,Read,AskUserQuestion',
    '--output-format', 'json',
  ];
  if (category.needsSearch) {
    args.push('--allowedTools', 'WebSearch');
  }

  try {
    const stdout = execFileSync('claude', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    const parsed = JSON.parse(stdout);
    return (parsed.result || '').trim();
  } finally {
    fs.unlinkSync(promptFile);
  }
}

function violatesBannedPatterns(text) {
  return BANNED_PATTERNS.some((re) => re.test(text));
}

// Xの実際の文字数カウント方式に合わせた重み付き長さ計算。
// URLは実際の文字数に関わらず一律23文字換算、全角相当の文字は2、それ以外は1として数える。
const URL_REGEX = /https?:\/\/\S+/g;
const TWITTER_URL_WEIGHT = 23;
const MAX_WEIGHTED_LENGTH = 270; // 280の公式上限に対して安全マージンを確保

function weightedTweetLength(text) {
  const urlCount = (text.match(URL_REGEX) || []).length;
  const withoutUrls = text.replace(URL_REGEX, '');
  let weight = urlCount * TWITTER_URL_WEIGHT;
  for (const ch of withoutUrls) {
    const code = ch.codePointAt(0);
    const isNarrow =
      code <= 0x10ff ||
      (code >= 0x2000 && code <= 0x200d) ||
      (code >= 0x2010 && code <= 0x201f) ||
      code === 0x2032 ||
      code === 0x2033;
    weight += isNarrow ? 1 : 2;
  }
  return weight;
}

async function postTweet(text) {
  return apiPostJson(`${X_API_BASE}/tweets`, { text }, config.posterAccessToken, config.posterAccessSecret);
}

// 投稿から一定時間経過したツイートのインプレッション数を取得し、時間帯ごとの成績(slotStats)に反映する
async function collectPendingMetrics(state) {
  if (!state.pendingMetrics || state.pendingMetrics.length === 0) return;

  const stillPending = [];
  for (const entry of state.pendingMetrics) {
    const hoursSincePost = (Date.now() - new Date(entry.postedAt).getTime()) / (60 * 60 * 1000);
    if (hoursSincePost < METRICS_DELAY_HOURS) {
      stillPending.push(entry);
      continue;
    }
    if (hoursSincePost > METRICS_GIVEUP_HOURS) {
      console.log(`ツイート${entry.tweetId}のインプレッション取得を断念(${METRICS_GIVEUP_HOURS}時間経過)`);
      continue;
    }
    try {
      const res = await apiGet(
        `${X_API_BASE}/tweets/${entry.tweetId}`,
        { 'tweet.fields': 'public_metrics' },
        config.posterAccessToken,
        config.posterAccessSecret
      );
      const impressions = res.data && res.data.public_metrics ? res.data.public_metrics.impression_count : undefined;
      if (typeof impressions !== 'number') {
        stillPending.push(entry); // まだ取得できない場合は次回リトライ
        continue;
      }
      const slot = entry.slot;
      const s = state.slotStats[slot] || { trials: 0, totalImpressions: 0 };
      s.trials += 1;
      s.totalImpressions += impressions;
      state.slotStats[slot] = s;

      if (entry.format) {
        const fs2 = state.formatStats[entry.format] || { trials: 0, totalImpressions: 0 };
        fs2.trials += 1;
        fs2.totalImpressions += impressions;
        state.formatStats[entry.format] = fs2;
      }

      const slotLabel = typeof slot === 'number' ? formatSlot(slot) : slot;
      console.log(`ツイート${entry.tweetId}(${slotLabel} / ${entry.format || '不明'})のインプレッション: ${impressions}`);
    } catch (err) {
      console.error(`インプレッション取得エラー(${entry.tweetId}): ${err.message}`);
      stillPending.push(entry);
    }
  }
  state.pendingMetrics = stillPending;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const state = loadState();

  await collectPendingMetrics(state);

  const today = todayJst();
  if (state.dailyPostCount.date !== today) {
    state.dailyPostCount = { date: today, count: 0 };
  }

  const plan = ensureTodaysPlan(state);
  if (!plan.postedSlots) plan.postedSlots = [];

  const feed = await fetchYoutubeFeed();
  const latest = feed[0];
  const hasNewVideo = !!(latest && latest.videoId !== state.lastVideoId);

  const currentSlot = currentSlotMinutesJst();
  // GitHub Actionsのスケジュール実行は数十分〜数時間遅れることがあるため、
  // 「ちょうど今の時刻」ではなく「もう時刻が来ていて、まだ消化していない最も早い枠」を拾う
  const dueSlot = plan.slots.find((s) => s <= currentSlot && !plan.postedSlots.includes(s));
  const isPlannedSlot = dueSlot !== undefined;

  if (!hasNewVideo && !isPlannedSlot) {
    console.log(`${formatSlot(currentSlot)}: 消化すべき予定枠がないためスキップします(予定: ${plan.slots.map(formatSlot).join(', ')}、消化済み: ${plan.postedSlots.map(formatSlot).join(', ') || 'なし'})。`);
    saveState(state); // メトリクス収集結果は保存する
    return;
  }

  if (state.dailyPostCount.count >= MAX_POSTS_PER_DAY) {
    console.log(`本日の投稿上限(${MAX_POSTS_PER_DAY}件)に達しているためスキップします。`);
    saveState(state);
    return;
  }

  const categoryId = pickCategory(state.recentCategories, hasNewVideo);
  const formatId = pickFormat(state.formatStats, state.recentFormats);
  console.log(`選択されたカテゴリ: ${categoryId} / 切り口: ${formatId}`);

  const context = {};
  if (categoryId === 'video_announcement') {
    context.videoTitle = latest.title;
    context.videoUrl = latest.url;
  } else if (categoryId === 'video_recap') {
    const fxVideos = filterFxRelated(feed);
    if (fxVideos.length > 0) {
      context.videoTitle = fxVideos[Math.floor(Math.random() * fxVideos.length)].title;
    }
    // 該当がない場合はbuildPrompt側のデフォルトタイトルにフォールバックする
  }

  const MIN_WEIGHTED_LENGTH = 16; // バズ狙いの短い一言ツイートは許容しつつ、実質空(1文字だけ等)のゴミ出力だけを弾く

  function isValid(t) {
    const w = weightedTweetLength(t);
    return t.length > 0 && w >= MIN_WEIGHTED_LENGTH && w <= MAX_WEIGHTED_LENGTH && !violatesBannedPatterns(t);
  }

  // 「AIっぽさ」を消し、実際に反応が取れている文体を学ばせるための参考ツイート
  // (すべてキャッシュ済みなので、毎回参照してもコストはほぼ増えない)
  const trendExamples = await ensureCache(state, 'fxTrendCache', TREND_CACHE_VALID_DAYS, () => fetchTweetsBySearch(FX_TREND_SEARCH_QUERY), 'FXトレンド分析');
  const viralExamples = await ensureCache(state, 'viralTrendCache', TREND_CACHE_VALID_DAYS, () => fetchTweetsBySearch(VIRAL_TREND_SEARCH_QUERY), 'バズツイート分析');

  let text = await generateTweet(categoryId, context, formatId, trendExamples, viralExamples);
  console.log('生成結果 (weighted ' + weightedTweetLength(text) + '):\n' + text);

  if (!isValid(text)) {
    console.log('禁止表現または文字数超過を検出。再生成します。');
    text = await generateTweet(categoryId, context, formatId, trendExamples, viralExamples);
    console.log('再生成結果 (weighted ' + weightedTweetLength(text) + '):\n' + text);
  }

  if (!isValid(text)) {
    console.error('再生成後も条件を満たさないため、今回は投稿をスキップします。');
    saveState(state);
    return;
  }

  if (dryRun) {
    console.log('(dry-run) 投稿はスキップしました。');
    saveState(state); // メトリクス収集結果・当日プランは保存する(投稿カウント等は更新しない)
    return;
  }

  const posted = await postTweet(text);
  console.log('投稿しました。');

  state.recentCategories = [...(state.recentCategories || []), categoryId].slice(-5);
  state.recentFormats = [...(state.recentFormats || []), formatId].slice(-5);
  if (categoryId === 'video_announcement') state.lastVideoId = latest.videoId;
  state.dailyPostCount.count += 1;
  if (isPlannedSlot) plan.postedSlots.push(dueSlot);
  state.pendingMetrics.push({
    tweetId: posted.data.id,
    slot: isPlannedSlot ? dueSlot : 'unplanned',
    format: formatId,
    postedAt: new Date().toISOString(),
  });
  saveState(state);
}

main().catch((err) => {
  console.error('エラー:', err.message);
  process.exit(1);
});
