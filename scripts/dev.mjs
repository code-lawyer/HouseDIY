import { startServer } from "../src/server.mjs";
import { resolve } from "node:path";
// Browser development only. Saved credentials require the desktop OS key store.
const service = await startServer({
  dataDir: resolve(".data"),
  secretCodec: {
    encrypt: async () => {
      throw new Error("请在桌面版中保存模型密钥");
    },
    decrypt: async () => {
      throw new Error("请在桌面版中读取模型密钥");
    },
  },
});
console.log("Development URL: " + service.url);
