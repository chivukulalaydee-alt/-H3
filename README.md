# 墨匠 H3 视频生成工作台

独立运行的本地 H3 API 调用客户端：填写 API 密钥和提示词、选择参考图片与音频、提交视频任务、查询进度并播放结果。

本仓库只包含工作台，不包含 H3 模型、ComfyUI、云端镜像或 API 运营后台。视频推理、计费、导演保护、人物参考与超分效果由所连接的服务决定。

## 启动

安装 Node.js 20 或更高版本，然后在仓库目录运行：

```sh
npm start
```

浏览器打开 `http://127.0.0.1:4317/`。项目无第三方 npm 依赖，无需先执行 `npm install`。

默认连接现有墨匠网关。连接其他兼容网关时，在启动前设置环境变量。PowerShell 示例：

```powershell
$env:H3_GATEWAY_BASE_URL = "https://your-gateway.example"
$env:PORT = "4317"
npm start
```

macOS/Linux 示例：

```sh
H3_GATEWAY_BASE_URL=https://your-gateway.example PORT=4317 npm start
```

网关地址应为服务根地址，不要重复添加 `/v1`。端口被占用时改用其他端口，不要停止不相关服务。

## 使用

1. 输入用户在 API 平台创建的密钥，可先点击“验证密钥”。
2. 输入提示词，选择时长、分辨率、比例与随机种子。
3. 按需要选择整体参考图、人物 1、人物 2、背景图及最多两段音频。参考音频合计不超过 15 秒。
4. 点击“开始生成视频”，等待任务完成后播放结果。

本地图片支持 JPEG、PNG、WebP。媒体由本地代理在内存中转成数据地址后发送给网关，不是仅发送电脑上的文件路径。
“停止查询”仅停止当前页面轮询，不代表取消云端任务或停止扣费。
页面中的价格是静态参考展示，实际费用和额度以上游平台为准。

## 配置

| 环境变量 | 用途 |
| --- | --- |
| `H3_GATEWAY_BASE_URL` | 兼容 H3 视频 API 的网关根地址 |
| `HOST` | 监听地址，默认 `127.0.0.1` |
| `PORT` | 本地端口，默认 `4317` |
| `UPSTREAM_TIMEOUT_MS` | 上游请求超时毫秒数 |
| `MAX_BODY_BYTES` | 请求体大小上限 |

当前默认网关使用 HTTP。真实密钥与媒体应优先通过可信 HTTPS 网关传输。不要将工作台直接暴露到公网。

## 上游接口

工作台使用以下接口，并通过 `Authorization: Bearer <用户密钥>` 鉴权：

```text
GET  /v1/models
POST /v1/videos
GET  /v1/videos/:taskId
GET  /v1/videos/:taskId/content
```

模型标识和媒体参数按墨匠 H3 契约适配，不是任意视频厂商的通用客户端。
本机健康接口 `GET /api/health` 只证明工作台服务正常，不证明 GPU、额度或上游推理可用。

## 密钥与隐私

- 当前版本密钥仅保存在页面内存中，刷新后需重新输入，不会自动持久化。
- 最近任务保存在浏览器 localStorage 中，包含任务信息与提示词摘要，可在页面清空。
- 图片、音频和提示词会发送至所配置的上游服务。
- 服务输出简要运行日志，不应记录 API 密钥或完整授权头。
- 不要提交 `.env`、密钥、个人媒体、输出视频或日志。

## 测试

```sh
npm test
npm run test:mock-ui
```

自动测试覆盖请求转换、图片音频输入、任务查询、鉴权视频流、上游错误、超时与日志脱敏。
模拟工作台默认使用 `http://127.0.0.1:4318/`，模拟响应不代表真实视频推理结果，也不需要付费密钥。

## 文件结构

```text
server.mjs                 本地服务和上游代理
public/index.html          工作台页面
public/app.js              提交、上传、轮询和播放逻辑
public/styles.css          页面样式
tests/server.test.mjs      自动回归测试
tests/mock-upstream.mjs    模拟上游
tests/run-mock-workbench.mjs 模拟页面入口
```

这是独立工作台快照。真实生成效果和服务可用性需在用户自己的网关、密钥及 GPU 环境中验证。
