# 变更记录

## 2026-10-30

- 修复 Responses API 图片请求：Chat Completions 的 `image_url` 对象会转成 Responses 的 `input_image`，不再导致 HTTP 422。
- Responses 请求只保留原生的 `reasoning` 与 `text.format`，不再混入 `thinking`、`reasoning_effort` 和 `response_format`。
- 空回复与工具上限的催促改为用户消息，避免系统消息出现在用户消息之后导致 HTTP 400。
- 文本待发队列的队头连续失败超过 10 次后，按指数退避暂停自动补发，最长一小时；内容不会丢失。
