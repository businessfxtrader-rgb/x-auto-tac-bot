const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(configPath)) return require(configPath);
  return {
    consumerKey: process.env.CONSUMER_KEY,
    consumerSecret: process.env.CONSUMER_SECRET,
    posterAccessToken: process.env.POSTER_ACCESS_TOKEN,
    posterAccessSecret: process.env.POSTER_ACCESS_SECRET,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    youtubeChannelId: process.env.YOUTUBE_CHANNEL_ID,
  };
}

const { consumerKey, consumerSecret } = loadConfig();

function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function buildSignature(method, url, params, tokenSecret) {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(paramString),
  ].join('&');
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret || '')}`;
  return crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
}

function oauthParams(extra = {}) {
  return {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
    ...extra,
  };
}

function buildAuthHeader(params) {
  const parts = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(params[k])}"`);
  return 'OAuth ' + parts.join(', ');
}

async function postForm(url, authHeader) {
  const res = await fetch(url, { method: 'POST', headers: { Authorization: authHeader } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return Object.fromEntries(new URLSearchParams(text));
}

// GET request signed with a user's access token (query params included in signature)
async function apiGet(url, queryParams, accessToken, accessSecret) {
  const oParams = oauthParams({ oauth_token: accessToken });
  const sig = buildSignature('GET', url, { ...oParams, ...queryParams }, accessSecret);
  const header = buildAuthHeader({ ...oParams, oauth_signature: sig });
  const qs = new URLSearchParams(queryParams).toString();
  const fullUrl = qs ? `${url}?${qs}` : url;
  const res = await fetch(fullUrl, { headers: { Authorization: header } });
  const json = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// POST with JSON body signed with a user's access token (body NOT included in OAuth1 signature)
async function apiPostJson(url, bodyObj, accessToken, accessSecret) {
  const oParams = oauthParams({ oauth_token: accessToken });
  const sig = buildSignature('POST', url, oParams, accessSecret);
  const header = buildAuthHeader({ ...oParams, oauth_signature: sig });
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: header, 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

module.exports = { buildSignature, oauthParams, buildAuthHeader, postForm, apiGet, apiPostJson, loadConfig };
