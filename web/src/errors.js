// 统一错误类型：segment 指出坏段（字符串表#i、签名表#i、消息表[lang/key]节点#i、末尾CRC 等）
export class LcpError extends Error {
  constructor(message, segment = null) {
    super(message);
    this.name = 'LcpError';
    this.segment = segment;
  }
  toString() {
    return this.segment ? `[${this.segment}] ${this.message}` : this.message;
  }
}
