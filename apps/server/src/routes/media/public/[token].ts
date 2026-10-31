import { Router } from "express";
import u from "@/utils";

// ACT: Agnes 只能拉取公网地址；这里用一次性随机令牌暴露参考素材，令牌过期即失效。
export default Router().get("/:token", (req, res) => {
  const token = req.params.token;
  if (!/^[a-f0-9]{64}$/.test(token)) throw Object.assign(new Error("参考素材不存在或已过期"), { status: 404 });
  const entry = u.mediaPublicAssets.read(token);
  if (!entry) throw Object.assign(new Error("参考素材不存在或已过期"), { status: 404 });
  res.set({
    "Content-Type": entry.mimeType,
    "Content-Length": String(entry.bytes.byteLength),
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(Buffer.from(entry.bytes));
});
