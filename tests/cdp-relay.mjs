// WSL 侧并发 TCP 中继（零依赖），采用控制通道 + 按需数据连接模型。
//   front   : CDP 客户端（Node）连入，每个连接分配自增 connId
//   manager : Windows 桥接维持的单一长连接；中继把 connId 逐行发给它
//   data    : 桥接为每个 connId 主动连入，首字节序列为 "ID:<connId>\n"，
//             中继据此与对应 front 配对后全双工透传。
import net from 'node:net';

const FRONT_PORT = Number(process.env.FRONT_PORT || 9310);
const MANAGER_PORT = Number(process.env.MANAGER_PORT || 9311);
const DATA_PORT = Number(process.env.DATA_PORT || 9312);
const TIMEOUT_MS = 30000;

const pending = new Map(); // connId -> front socket
let nextId = 1;
let manager = null;
let managerQueue = [];     // 管理器断连期间缓存的 connId

function sendManager(line) {
  if (manager && !manager.destroyed) manager.write(line + '\n');
  else managerQueue.push(line);
}

function pump(src, dst) {
  src.on('data', (d) => { if (!dst.destroyed) dst.write(d); });
  src.on('end', () => { try { dst.end(); } catch {} });
  src.on('error', () => { try { dst.destroy(); } catch {} });
}

// 控制通道（单连接；新连接替换旧的）
net.createServer((sock) => {
  sock.on('error', () => {});
  manager = sock;
  // 重连后补发积压
  for (const line of managerQueue) sock.write(line + '\n');
  managerQueue = [];
  sock.on('close', () => { if (manager === sock) manager = null; });
}).listen(MANAGER_PORT, '0.0.0.0');

// 数据通道：桥接按需连入，首行 ID:<n>
net.createServer((sock) => {
  sock.on('error', () => {});
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(0x0a);
    if (nl < 0) return;
    const header = buf.slice(0, nl).toString('utf8').trim();
    const rest = buf.slice(nl + 1);
    sock.removeListener('data', onData);
    const m = /^ID:(\d+)$/.exec(header);
    if (!m) { sock.destroy(); return; }
    const front = pending.get(Number(m[1]));
    if (!front) { sock.destroy(); return; }
    pending.delete(front.connId);
    front.setTimeout(0);
    if (rest.length) front.write(rest);
    pump(sock, front);
    pump(front, sock);
    const close = () => { try { front.destroy(); } catch {} try { sock.destroy(); } catch {} };
    front.on('close', close);
    sock.on('close', close);
  };
  sock.on('data', onData);
}).listen(DATA_PORT, '0.0.0.0');

// 前端：CDP 客户端
net.createServer((sock) => {
  sock.on('error', () => {});
  const connId = nextId++;
  sock.connId = connId;
  pending.set(connId, sock);
  sock.setTimeout(TIMEOUT_MS, () => {
    if (pending.delete(connId)) sock.destroy();
  });
  sendManager(`CONN:${connId}`);
}).listen(FRONT_PORT, '127.0.0.1', () => {
  console.log(`relay: front=127.0.0.1:${FRONT_PORT} manager=0.0.0.0:${MANAGER_PORT} data=0.0.0.0:${DATA_PORT}`);
});
