// SPDX-FileCopyrightText: 2026 Dédale Solutions
// SPDX-License-Identifier: EUPL-1.2

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

const MAX_BODY_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15000;
const PROXY_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

/**
 * Lit la configuration depuis l'environnement. Les URLs des services sont celles du réseau interne
 * (le navigateur ne parle qu'à ce serveur : même origine, pas de CORS).
 */
function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    authUrl: trimSlash(env.ARC_AUTH_URL || 'http://arc-auth:8082'),
    productManagerUrl: trimSlash(env.ARC_PRODUCT_MANAGER_URL || 'http://product-manager:8080'),
    identityManagerUrl: trimSlash(env.ARC_IDENTITY_MANAGER_URL || 'http://identity-manager:8083'),
    publicDir: env.ARC_CONSOLE_PUBLIC_DIR || path.join(__dirname, 'public'),
  };
}

function trimSlash(url) {
  return url.replace(/\/+$/, '');
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, object) {
  send(res, status, JSON.stringify(object), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('corps trop volumineux'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Relaie une requête vers un service amont. Seuls l'en-tête Authorization et le type de contenu sont
 * transmis ; le jeton n'est jamais journalisé.
 */
async function proxy(req, res, targetUrl) {
  if (!PROXY_METHODS.has(req.method)) {
    sendJson(res, 405, { error: 'méthode non autorisée' });
    return;
  }
  let body;
  try {
    body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await readBody(req);
  } catch (error) {
    sendJson(res, error.status || 400, { error: error.message });
    return;
  }
  const headers = { Accept: 'application/json' };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  if (body && body.length > 0) headers['Content-Type'] = req.headers['content-type'] || 'application/json';
  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: body && body.length > 0 ? body : undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const payload = Buffer.from(await upstream.arrayBuffer());
    const responseHeaders = {};
    const type = upstream.headers.get('content-type');
    if (type) responseHeaders['Content-Type'] = type;
    send(res, upstream.status, payload, responseHeaders);
  } catch (error) {
    console.error(`amont injoignable (${req.method} ${new URL(targetUrl).origin}): ${error.name}`);
    sendJson(res, 502, { error: 'service amont injoignable' });
  }
}

/** Résout la cible amont d'un chemin `/api/<service>/...`, ou null. */
function resolveUpstream(config, pathname, search) {
  const routes = [
    ['/api/pm/', config.productManagerUrl],
    ['/api/im/', config.identityManagerUrl],
  ];
  for (const [prefix, base] of routes) {
    if (pathname.startsWith(prefix)) {
      const rest = pathname.slice(prefix.length - 1);
      if (rest.split('/').some((segment) => segment === '..')) return null;
      return `${base}${rest}${search}`;
    }
  }
  return null;
}

function serveStatic(config, req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'méthode non autorisée' });
    return;
  }
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: 'chemin invalide' });
    return;
  }
  if (relative === '/') relative = '/index.html';
  const root = path.resolve(config.publicDir);
  const file = path.resolve(root, `.${relative}`);
  if (file !== root && !file.startsWith(root + path.sep)) {
    sendJson(res, 404, { error: 'introuvable' });
    return;
  }
  fs.readFile(file, (error, content) => {
    if (error) {
      sendJson(res, 404, { error: 'introuvable' });
      return;
    }
    send(res, 200, req.method === 'HEAD' ? undefined : content, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    });
  });
}

function createServer(config = loadConfig()) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://console.local');
    const { pathname, search } = url;

    if (pathname === '/healthz') {
      sendJson(res, 200, { status: 'UP' });
      return;
    }
    if (pathname === '/auth/token') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'méthode non autorisée' });
        return;
      }
      await proxy(req, res, `${config.authUrl}/token`);
      return;
    }
    if (pathname.startsWith('/api/')) {
      const target = resolveUpstream(config, pathname, search);
      if (!target) {
        sendJson(res, 404, { error: 'introuvable' });
        return;
      }
      await proxy(req, res, target);
      return;
    }
    serveStatic(config, req, res, pathname);
  });
}

if (require.main === module) {
  const config = loadConfig();
  createServer(config).listen(config.port, () => {
    console.log(`arc-console à l'écoute sur le port ${config.port}`);
  });
}

module.exports = { createServer, loadConfig, resolveUpstream };
