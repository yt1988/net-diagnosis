# 网络诊断

[English](README.md) · **简体中文**

网卡了？网络诊断在你自己的浏览器里同时测几条路，判断问题出在哪一段：设备、Wi‑Fi 和宽带、跨境线路、代理，还是某个服务。20 秒给出结论，之后可以持续监控，每次出问题都记下来。

## 测什么

| 路径的哪一段 | 怎么测 | 频率 |
|---|---|---|
| 设备 | Worker 里 250 ms 定时器迟到多少 | 持续 |
| 近处 | 最近的 Cloudflare 节点（`speed.cloudflare.com`）；中国大陆用国内网站 | 1 秒 |
| 远处 | 单一地点的云区域：东京、法兰克福、弗吉尼亚（AWS DynamoDB `/ping`） | 5 秒 |
| UDP | 向公共 STUN 服务器取地址（Cloudflare、Google；中国大陆还有小米、哔哩哔哩） | 1 秒 |
| 常用服务 | 你选的服务（ChatGPT、Google、GitHub……，1ms.dog 每天检查的地址） | 5 秒 |

`src/lib.mjs` 按 5 秒一个时间窗判断：

- 所有路同时变差：问题在你这一侧（Wi‑Fi、路由器、宽带）；
- 近处正常、远处变差：跨境或远程线路；
- 只有一个服务变差：那个服务自己的问题；
- HTTPS 正常但 UDP 丢包：游戏和通话会卡。

在中国大陆开着代理时，用国内网站（不经过代理）代表你自己的宽带，用经代理到最近的 Cloudflare 节点代表到代理节点这一段，用远处的云区域代表节点之后的路。每条结论都附依据和把握程度。

**UDP 丢包**从 STUN 的重传延迟推算：请求丢了，libwebrtc 会在 250 ms 后重发，之后再隔 500、1000 ms，所以回答晚了多少，就能看出前面丢了几次。每个回答单独计算，因为 IPv4 和 IPv6 各问一次，只看最快的那个会把另一边的丢包掩盖掉。

我们在 Linux VPS 上随机丢弃回来的 STUN 响应做过验证：注入 2% / 5% / 10%，测出 1.3–2.0% / 4.4–4.8% / 8.2–9.1%。这组数据放在 `test/fixtures/stun-loss-2026-11-06.json`，测试里会回放。

**调度放在专用 Worker 里**：后台标签页里，Chrome 会把页面的定时器链压到每分钟一次（开着 WebRTC 连接时是每 2 秒一次），Worker 仍然每秒一次。这是 2026-11-06 在 Chrome 156 上实测的。

**按需测量**：找到家里的路由器时多一行「路由器」（Chrome 的本地网络访问权限），把 Wi‑Fi 和宽带接入分开；「满载延迟」下载 10 秒看延迟涨多少；「精确测一下」向 `rtc.1ms.dog` 的 WebRTC 回声服务器发 20 秒 UDP，算出两个方向的丢包，再看 QUIC 能不能通。

**分享**：结果链接 `/r/<编码>` 里只有结论、数字和每一段的状态，不含 IP；`src/worker.js` 读这个编码，给链接预览加上结论标题。

## 开发

```bash
npm install
npm run dev     # http://localhost:8804
npm run build   # 改了 src/ 之后重新生成 public/（public/ 要提交）
npm test        # public/ 是否最新、逻辑单元测试和带标签的场景回放
npm run assets  # 改了标题之后重新生成 public/og/ 的预览图
```

自己部署时，`npx wrangler deploy` 之后在 Cloudflare 控制台给 Worker 绑一个域名即可。「精确测一下」用的是 `rtc.1ms.dog`，它只接受来自 1ms.dog 的页面；要在自己的域名上用，需要自己运行一份回声服务器（[speed-test 的 `server/`](https://github.com/yt1988/speed-test/tree/main/server)），并改 `src/rtc.mjs` 里的地址。其余测量都不依赖本站。

## 许可

[MIT](LICENSE)。柴犬插画和 1ms.dog 的 logo 属于本项目的品牌形象，如果你用别的名字公开运行一份，请换成你自己的。
