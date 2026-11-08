import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const dataRoot = join(root, 'vm-data');
const statePath = join(dataRoot, 'vms.json');
const qemuPath = '/usr/bin/qemu-system-x86_64';
const qemuImgPath = '/usr/bin/qemu-img';
const port = Number(process.env.PORT || 8002);
const maxUploadBytes = 10 * 1024 * 1024 * 1024;
const profiles = new Map();
let activeVM = null;

await mkdir(dataRoot, { recursive: true });
await loadState();

function safeId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

function profileDirectory(id) {
  if (!safeId(id)) throw new Error('Invalid virtual machine ID');
  return join(dataRoot, id);
}

function publicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    ramMb: profile.ramMb,
    diskName: profile.diskName,
    diskType: profile.diskType,
    imageSource: profile.imageSource,
    imageReady: profile.imageSource === 'builtin' || profile.imageSource === 'upload',
    running: activeVM?.id === profile.id,
  };
}

async function loadState() {
  try {
    const stored = JSON.parse(await readFile(statePath, 'utf8'));
    for (const profile of stored.profiles || []) {
      if (safeId(profile.id)) profiles.set(profile.id, normalizeProfile(profile));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not load VM state:', error);
  }
}

function normalizeProfile(profile) {
  const imageType = profile.diskType === 'img' ? 'img' : 'iso';
  let imageSource = ['builtin', 'upload'].includes(profile.imageSource) ? profile.imageSource : 'missing';
  let diskName = typeof profile.diskName === 'string' ? basename(profile.diskName).slice(0, 180) : 'No boot image';
  if (profile.diskSource === 'url' && profile.diskUrl === 'vm/linux.iso') {
    imageSource = 'builtin';
    diskName = 'Linux Live (x86)';
  }
  return {
    id: profile.id,
    name: typeof profile.name === 'string' ? profile.name.trim().slice(0, 40) || 'Virtual Machine' : 'Virtual Machine',
    ramMb: Math.min(8192, Math.max(512, Math.round((Number(profile.ramMb) || 2048) / 512) * 512)),
    diskName,
    diskType: imageType,
    imageSource,
  };
}

async function saveState() {
  const tempPath = `${statePath}.tmp`;
  await writeFile(tempPath, JSON.stringify({ profiles: [...profiles.values()] }, null, 2));
  await rename(tempPath, statePath);
}

async function ensureProfileDisk(id) {
  const directory = profileDirectory(id);
  await mkdir(directory, { recursive: true });
  const diskPath = join(directory, 'system.qcow2');
  try {
    await stat(diskPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await execFileAsync(qemuImgPath, ['create', '-f', 'qcow2', diskPath, '24G']);
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error('Request body too large');
  }
  return body ? JSON.parse(body) : {};
}

function stopVM() {
  if (!activeVM) return Promise.resolve();
  const current = activeVM;
  activeVM = null;
  return new Promise(resolveStop => {
    const timeout = setTimeout(() => current.child.kill('SIGKILL'), 5000);
    current.child.once('exit', () => {
      clearTimeout(timeout);
      resolveStop();
    });
    current.child.kill('SIGTERM');
  });
}

function waitForVNC(child) {
  return new Promise((resolveReady, rejectReady) => {
    const deadline = Date.now() + 15000;
    const tryConnect = () => {
      if (child.exitCode !== null) return rejectReady(new Error('QEMU exited before the VNC console became ready'));
      const socket = createConnection({ host: '127.0.0.1', port: 5900 });
      socket.once('connect', () => {
        socket.destroy();
        resolveReady();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) rejectReady(new Error('Timed out waiting for the QEMU console'));
        else setTimeout(tryConnect, 200);
      });
    };
    tryConnect();
  });
}

async function startVM(profile) {
  if (activeVM?.id === profile.id) return;
  await stopVM();
  await ensureProfileDisk(profile.id);
  const directory = profileDirectory(profile.id);
  const diskPath = join(directory, 'system.qcow2');
  const imagePath = profile.imageSource === 'builtin'
    ? join(root, 'vm', 'linux.iso')
    : join(directory, profile.diskType === 'img' ? 'boot.img' : 'boot.iso');
  if (profile.imageSource === 'missing') throw new Error('Select an ISO or IMG image before starting this virtual machine');
  await stat(imagePath);

  const args = [
    '-name', profile.name,
    '-machine', 'q35,accel=kvm:tcg',
    '-cpu', 'max',
    '-m', String(profile.ramMb),
    '-smp', '2',
    '-vga', 'std',
    '-display', 'none',
    '-vnc', '127.0.0.1:0',
    '-netdev', 'user,id=net0',
    '-device', 'e1000,netdev=net0',
    '-usb',
    '-device', 'usb-tablet',
    '-drive', `file=${diskPath},if=virtio,format=qcow2`,
  ];
  if (profile.diskType === 'img' && profile.imageSource === 'upload') {
    args.push('-drive', `file=${imagePath},if=none,id=bootdisk,format=raw`, '-device', 'virtio-blk-pci,drive=bootdisk,bootindex=1');
  } else {
    args.push('-drive', `file=${imagePath},media=cdrom,readonly=on,if=none,id=bootcd,format=raw`, '-device', 'ide-cd,drive=bootcd,bootindex=1');
  }

  const log = createWriteStream(join(directory, 'qemu.log'), { flags: 'a' });
  const child = spawn('sudo', ['-n', qemuPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  activeVM = { id: profile.id, child };
  child.once('exit', () => {
    log.end();
    if (activeVM?.child === child) activeVM = null;
  });
  try {
    await waitForVNC(child);
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}

function mimeType(filePath) {
  return ({
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.webp': 'image/webp', '.wasm': 'application/wasm',
  })[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function serveStatic(request, response, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { response.writeHead(400).end(); return; }
  const base = decoded.startsWith('/node_modules/') ? root : root;
  const filePath = resolve(base, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const file = await stat(filePath);
    if (!file.isFile()) throw new Error('Not a file');
    response.writeHead(200, { 'content-type': mimeType(filePath), 'cache-control': 'no-store' });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) {
      sendJson(response, 403, { error: 'Cross-origin requests are not allowed' });
      return;
    }
    if (url.pathname === '/api/vms' && request.method === 'GET') {
      sendJson(response, 200, { vms: [...profiles.values()].map(publicProfile), activeId: activeVM?.id || null });
      return;
    }
    if (url.pathname === '/api/vms/import' && request.method === 'POST') {
      if (profiles.size) { sendJson(response, 409, { error: 'VM profiles already initialized' }); return; }
      const body = await readJson(request);
      for (const item of Array.isArray(body.vms) ? body.vms.slice(0, 32) : []) {
        const id = safeId(item.id) ? item.id : `vm-${crypto.randomUUID()}`;
        const profile = normalizeProfile({ ...item, id });
        profiles.set(id, profile);
        await ensureProfileDisk(id);
      }
      await saveState();
      sendJson(response, 201, { vms: [...profiles.values()].map(publicProfile) });
      return;
    }
    if (url.pathname === '/api/vms' && request.method === 'POST') {
      const body = await readJson(request);
      const id = `vm-${crypto.randomUUID()}`;
      const profile = normalizeProfile({ id, name: body.name, ramMb: body.ramMb, diskName: 'No boot image', diskType: 'iso' });
      profiles.set(id, profile);
      await ensureProfileDisk(id);
      await saveState();
      sendJson(response, 201, { vm: publicProfile(profile) });
      return;
    }

    const match = url.pathname.match(/^\/api\/vms\/([a-zA-Z0-9_-]+)(?:\/(start|stop|media|builtin))?$/);
    if (match) {
      const [, id, action] = match;
      if (!safeId(id) || !profiles.has(id)) { sendJson(response, 404, { error: 'Virtual machine not found' }); return; }
      const profile = profiles.get(id);
      if (!action && request.method === 'PATCH') {
        const body = await readJson(request);
        if (typeof body.name === 'string') profile.name = body.name.trim().slice(0, 40) || profile.name;
        if (Number.isFinite(Number(body.ramMb))) profile.ramMb = Math.min(8192, Math.max(512, Math.round(Number(body.ramMb) / 512) * 512));
        await saveState();
        sendJson(response, 200, { vm: publicProfile(profile) });
        return;
      }
      if (!action && request.method === 'DELETE') {
        if (profiles.size <= 1) { sendJson(response, 409, { error: 'Keep at least one virtual machine' }); return; }
        if (activeVM?.id === id) await stopVM();
        profiles.delete(id);
        await rm(profileDirectory(id), { recursive: true, force: true });
        await saveState();
        sendJson(response, 200, { vms: [...profiles.values()].map(publicProfile) });
        return;
      }
      if (action === 'media' && request.method === 'PUT') {
        const type = url.searchParams.get('type');
        if (!['iso', 'img'].includes(type)) { sendJson(response, 400, { error: 'Only ISO and IMG files are supported' }); return; }
        const length = Number(request.headers['content-length'] || 0);
        if (length > maxUploadBytes) { sendJson(response, 413, { error: 'Image exceeds the 10 GB upload limit' }); return; }
        const directory = profileDirectory(id);
        await mkdir(directory, { recursive: true });
        const target = join(directory, type === 'img' ? 'boot.img' : 'boot.iso');
        const temp = `${target}.upload`;
        let total = 0;
        const output = createWriteStream(temp, { flags: 'w' });
        for await (const chunk of request) {
          total += chunk.length;
          if (total > maxUploadBytes) { output.destroy(); await rm(temp, { force: true }); sendJson(response, 413, { error: 'Image exceeds the 10 GB upload limit' }); return; }
          if (!output.write(chunk)) await new Promise(resolveDrain => output.once('drain', resolveDrain));
        }
        await new Promise((resolveFinish, rejectFinish) => output.end(error => error ? rejectFinish(error) : resolveFinish()));
        await rename(temp, target);
        profile.diskName = basename(decodeURIComponent(request.headers['x-image-name'] || target)).slice(0, 180);
        profile.diskType = type;
        profile.imageSource = 'upload';
        await saveState();
        sendJson(response, 200, { vm: publicProfile(profile) });
        return;
      }
      if (action === 'builtin' && request.method === 'POST') {
        profile.diskName = 'Linux Live (x86)';
        profile.diskType = 'iso';
        profile.imageSource = 'builtin';
        await saveState();
        sendJson(response, 200, { vm: publicProfile(profile) });
        return;
      }
      if (action === 'start' && request.method === 'POST') {
        await startVM(profile);
        sendJson(response, 200, { activeId: id, vms: [...profiles.values()].map(publicProfile) });
        return;
      }
      if (action === 'stop' && request.method === 'POST') {
        if (activeVM?.id === id) await stopVM();
        sendJson(response, 200, { activeId: activeVM?.id || null });
        return;
      }
    }
    if (url.pathname.startsWith('/api/')) { sendJson(response, 404, { error: 'API route not found' }); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    await serveStatic(request, response, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error.message || 'Internal server error' });
  }
});

const webSockets = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
server.on('upgrade', (request, socket, head) => {
  if (new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname !== '/websockify') {
    socket.destroy();
    return;
  }
  webSockets.handleUpgrade(request, socket, head, webSocket => webSockets.emit('connection', webSocket, request));
});

webSockets.on('connection', webSocket => {
  if (!activeVM) { webSocket.close(1011, 'No virtual machine is running'); return; }
  const vnc = createConnection({ host: '127.0.0.1', port: 5900 });
  vnc.on('data', data => { if (webSocket.readyState === WebSocket.OPEN) webSocket.send(data, { binary: true }); });
  webSocket.on('message', data => { if (!vnc.destroyed) vnc.write(data); });
  webSocket.on('close', () => vnc.destroy());
  webSocket.on('error', () => vnc.destroy());
  vnc.on('error', () => webSocket.close(1011, 'QEMU VNC connection failed'));
  vnc.on('close', () => { if (webSocket.readyState === WebSocket.OPEN) webSocket.close(); });
});

server.listen(port, '0.0.0.0', () => console.log(`QEMU VM manager listening on http://0.0.0.0:${port}`));
process.on('SIGINT', async () => { await stopVM(); server.close(() => process.exit(0)); });
process.on('SIGTERM', async () => { await stopVM(); server.close(() => process.exit(0)); });