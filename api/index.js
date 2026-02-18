// Vercel Serverless：显式导出 (req, res) 处理函数，避免部分运行时对 default export 的兼容问题
import app from '../server.js';

export default function handler(req, res) {
  return app(req, res);
}
