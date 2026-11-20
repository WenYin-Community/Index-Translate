# Cloudflare Workers 翻译代理部署

[English](README.md)

把 [Index-Translate](https://github.com/bilibili/Index-Translate) 的 OpenAI 兼容桥接代理部署到 Cloudflare Workers：零服务器，免费计划 **10 万请求/天**，适合手机、平板、多台电脑共用一个固定地址。

## 它做了什么

- 转发 `/v1/chat/completions`、`/v1/completions`、`/v1/responses`
- 自动补 `chat_template_kwargs.enable_thinking = false`，避免思维链混进译文
- 调用方未指定时把 `temperature` 设为 `0`
- 补 CORS，并注入上游 WAF 需要的 `User-Agent`
- SSE 流式响应原样透传，不缓冲

## 免费额度（Free 计划）

| 项目 | 额度 |
| --- | --- |
| 请求数 | 100,000 次/天（UTC 零点重置） |
| CPU 时间 | 10 ms/次（只算 CPU，等待上游的 I/O 不计） |
| 内存 | 128 MB |
| 请求体 | 最大 100 MB（受域名所在 Cloudflare 套餐影响） |
| 出站连接 | 每请求最多 6 个并发等待响应头 |
| 子请求 | 50 个/请求 |
| Worker 脚本 | 64 MiB（未压缩） |

文本翻译的 CPU 开销很小。大图片（base64）的 `JSON.parse` 可能接近或超过 10 ms CPU 限制，建议单张图片不超过 2 MB。

## 前置条件

- Node.js 18+（已验证 Node 24）
- Cloudflare 账号

## 部署

```bash
cd deploy/cloudflare
npm install
npx wrangler login
npx wrangler secret put PROXY_TOKEN   # 粘贴下面生成的 key
npm run deploy
```

生成一个 256 位随机 key：

```bash
python3 -c "import secrets; print('itk_' + secrets.token_urlsafe(32))"
```

`wrangler deploy` 成功后会输出 `https://index-translate-proxy.<你的子域>.workers.dev`。

> [!IMPORTANT]
> `PROXY_TOKEN` 只应保存在 Cloudflare Secret 和本地 `.dev.vars`（已 gitignore）。**不要写进 `wrangler.toml`、README 或提交历史。** 未配置时 Worker 会直接返回 `503`，避免误部署成公开的开放代理。

## 本地调试

```bash
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填入与线上相同的 key
npm run dev
```

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/v1/models
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $PROXY_TOKEN" \
  -d '{"model":"Index-Translate-35B-A3B","messages":[{"role":"user","content":"请将以下文本翻译为英语，直接输出翻译结果。\n\n你好，世界。"}]}'
```

流式验证：

```bash
curl -N -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -H "Authorization: Bearer $PROXY_TOKEN" \
  -d '{"model":"Index-Translate-35B-A3B","stream":true,"messages":[{"role":"user","content":"请翻译：你好，世界。"}]}'
```

## 沉浸式翻译配置

| 配置项 | 值 |
| --- | --- |
| 翻译服务 | `OpenAI` |
| 自定义接口地址 (API URL) | `https://<worker>.<subdomain>.workers.dev/v1` |
| 模型名称 (Model) | `Index-Translate-35B-A3B` |
| API Key | 部署时设置的 `PROXY_TOKEN` |
| 每秒最大请求数 | `3` ~ `5` |

## 自定义域名

域名必须已经接入 Cloudflare。在 `wrangler.toml` 中取消注释并改成自己的域名：

```toml
routes = [{ pattern = "translate.example.com", custom_domain = true }]
```

然后重新 `npm run deploy`。

## 已知限制

- **网络位置**：Workers 在海外边缘节点运行，中国大陆访问 `workers.dev` 可能不稳定；上游 `index-translate.bilibili.com` 从海外访问的延迟也需要实测。如果主要用户在大陆，腾讯云 CloudBase 上海云托管通常更快。
- **10 ms CPU**：免费计划按 CPU 时间限制，文本代理足够；超大图片可能超限。
- **免费计划无 SLA**：仅建议个人使用。
- **上游 WAF**：如果上游对数据中心 IP 返回 403/挑战页，Worker 无法绕过；此时改用本地代理或 CloudBase。
- **密钥轮换**：重新执行 `npx wrangler secret put PROXY_TOKEN` 覆盖，客户端同步更新即可。

## 许可

本目录代码同样遵循仓库根目录的 Apache-2.0 许可。
