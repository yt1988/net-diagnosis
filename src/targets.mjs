// What the diagnosis measures. Every URL is a small answer from the service's edge with no redirect, so a request on
// an open connection times one round trip. Endpoints come from the other 1ms.dog tools, where they are checked
// daily: services from 1ms.dog (src/services.mjs), cloud regions from Me2Cloud.

// The nearest Cloudflare location. Sends Timing-Allow-Origin, so the connection setup is readable too.
export const NEAR = { id: 'cf', name: 'Cloudflare', url: 'https://speed.cloudflare.com/__down?bytes=0' };
// Cloudflare's own view of this connection (CORS): exit IP, country, network, location
export const META = 'https://speed.cloudflare.com/meta';

// Domestic sites for visitors in mainland China: reached without a proxy when the proxy splits traffic, so they
// tell the visitor's own line from the proxy's.
export const DIRECT = {
  CN: [
    { id: 'baidu', name: { 'zh-CN': '百度', 'zh-TW': '百度', other: 'Baidu' }, url: 'https://www.baidu.com/favicon.ico' },
    { id: 'bilibili', name: { 'zh-CN': '哔哩哔哩', 'zh-TW': '嗶哩嗶哩', other: 'Bilibili' }, url: 'https://www.bilibili.com/favicon.ico' },
  ],
};

// Single-location cloud regions on three continents: a long path that crosses borders and backbones
export const FAR = [
  { id: 'tyo', region: 'ap-northeast-1', url: 'https://dynamodb.ap-northeast-1.amazonaws.com/ping' },
  { id: 'fra', region: 'eu-central-1', url: 'https://dynamodb.eu-central-1.amazonaws.com/ping' },
  { id: 'iad', region: 'us-east-1', url: 'https://dynamodb.us-east-1.amazonaws.com/ping' },
];

// Services the visitor can follow (a few by default)
export const SERVICES = [
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/favicon.ico', on: true },
  { id: 'google', name: 'Google', url: 'https://www.google.com/generate_204', on: true },
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/generate_204' },
  { id: 'github', name: 'GitHub', url: 'https://github.com/favicon.ico', on: true },
  { id: 'steam', name: 'Steam', url: 'https://store.steampowered.com/favicon.ico' },
  { id: 'netflix', name: 'Netflix', url: 'https://www.netflix.com/favicon.ico' },
  { id: 'discord', name: 'Discord', url: 'https://discord.com/favicon.ico' },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/cdn-cgi/trace' },
];

// Public STUN servers, taken in turn. Cloudflare's is anycast, so it lands at the same nearest location as NEAR:
// UDP against TCP on the same path. Domestic ones for mainland China.
export const STUN = [
  { id: 'cf', url: 'stun:stun.cloudflare.com:3478', ref: true },
  { id: 'google', url: 'stun:stun.l.google.com:19302' },
];
export const STUN_DIRECT = {
  CN: [
    { id: 'miwifi', url: 'stun:stun.miwifi.com:3478' },
    { id: 'bilibili', url: 'stun:stun.chat.bilibili.com:3478' },
  ],
};

export const ORIGINS = [...new Set([NEAR.url, META, ...Object.values(DIRECT).flat().map((t) => t.url), ...FAR.map((t) => t.url), ...SERVICES.map((t) => t.url)].map((u) => new URL(u).origin))];
