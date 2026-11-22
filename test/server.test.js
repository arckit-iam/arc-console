// SPDX-FileCopyrightText: 2026 Dédale Solutions
// SPDX-License-Identifier: EUPL-1.2

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { createServer, resolveUpstream } = require('../server');

const received = [];
let upstream;
let console_;
let publicDir;
let base;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
        body: Buffer.concat(chunks).toString(),
      });
      if (req.url.endsWith('/boom')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"boom"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const upstreamPort = await listen(upstream);

  publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-console-'));
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<h1>console</h1>');
  fs.writeFileSync(path.join(publicDir, 'app.js'), 'x');
  fs.writeFileSync(path.join(os.tmpdir(), 'arc-console-secret.txt'), 'secret');

  const url = `http://127.0.0.1:${upstreamPort}`;
  console_ = createServer({
    port: 0,
    authUrl: `${url}/auth`,
    productManagerUrl: `${url}/pm`,
    identityManagerUrl: `${url}/im`,
    publicDir,
  });
  base = `http://127.0.0.1:${await listen(console_)}`;
});

after(() => {
  console_.close();
  upstream.close();
  fs.rmSync(publicDir, { recursive: true, force: true });
});

test('health is public', async () => {
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'UP' });
});

test('serves the single page with strict security headers', async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await response.text(), '<h1>console</h1>');
});

test('refuses path traversal and unknown files', async () => {
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  const raw = await new Promise((resolve) => {
    const request = http.request(
      { host: '127.0.0.1', port: new URL(base).port, path: '/..%2farc-console-secret.txt', method: 'GET' },
      (res) => resolve(res.statusCode),
    );
    request.end();
  });
  assert.equal(raw, 404);
  assert.equal((await fetch(`${base}/%zz`)).status, 400);
});

test('static files only accept GET and HEAD', async () => {
  assert.equal((await fetch(`${base}/app.js`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/app.js`, { method: 'HEAD' })).status, 200);
});

test('forwards the login to arc-auth without adding credentials', async () => {
  received.length = 0;
  const response = await fetch(`${base}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'x=1' },
    body: '{"username":"alice","password":"p"}',
  });
  assert.equal(response.status, 200);
  assert.equal(received[0].url, '/auth/token');
  assert.equal(received[0].body, '{"username":"alice","password":"p"}');
  assert.equal(received[0].cookie, undefined);
  assert.equal((await fetch(`${base}/auth/token`)).status, 405);
});

test('proxies the product-manager and identity-manager with the bearer token', async () => {
  received.length = 0;
  await fetch(`${base}/api/pm/products?x=1`, { headers: { Authorization: 'Bearer abc' } });
  await fetch(`${base}/api/im/identities`, {
    method: 'POST',
    headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' },
    body: '{"employeeId":"e1"}',
  });
  await fetch(`${base}/api/im/accounts/e1`, { method: 'DELETE', headers: { Authorization: 'Bearer abc' } });

  assert.deepEqual(
    received.map((r) => [r.method, r.url, r.authorization]),
    [
      ['GET', '/pm/products?x=1', 'Bearer abc'],
      ['POST', '/im/identities', 'Bearer abc'],
      ['DELETE', '/im/accounts/e1', 'Bearer abc'],
    ],
  );
  assert.equal(received[1].body, '{"employeeId":"e1"}');
});

test('relays upstream error statuses unchanged', async () => {
  const response = await fetch(`${base}/api/pm/boom`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'boom' });
});

test('rejects unknown services, unsupported methods and oversized bodies', async () => {
  assert.equal((await fetch(`${base}/api/other/x`)).status, 404);
  assert.equal((await fetch(`${base}/api/pm/products`, { method: 'PATCH', body: '{}' })).status, 405);
  const big = 'x'.repeat(1024 * 1024 + 10);
  const response = await fetch(`${base}/api/pm/products`, { method: 'POST', body: big }).catch(() => null);
  assert.ok(response === null || response.status === 413);
});

test('answers 502 when the upstream is unreachable', async () => {
  const dead = createServer({
    port: 0,
    authUrl: 'http://127.0.0.1:1',
    productManagerUrl: 'http://127.0.0.1:1',
    identityManagerUrl: 'http://127.0.0.1:1',
    publicDir,
  });
  const port = await listen(dead);
  const response = await fetch(`http://127.0.0.1:${port}/api/pm/products`);
  assert.equal(response.status, 502);
  dead.close();
});

test('resolveUpstream refuses traversal segments', () => {
  const config = { productManagerUrl: 'http://pm', identityManagerUrl: 'http://im' };
  assert.equal(resolveUpstream(config, '/api/pm/products', '?a=1'), 'http://pm/products?a=1');
  assert.equal(resolveUpstream(config, '/api/pm/../admin', ''), null);
  assert.equal(resolveUpstream(config, '/api/zz/x', ''), null);
});
