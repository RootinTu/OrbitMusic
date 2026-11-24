import crypto from 'node:crypto';

export const SESSION_COOKIE_NAME = 'orbit_session';
export const API_TOKEN_HEADER = 'x-orbit-token';

const PRIVILEGED_COOKIE_ROUTES = new Set([
  '/api/qq/login/cookie',
  '/api/netease/login/cookie',
]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PAGE_PATHS = new Set(['/', '/index.html', '/visual-lab.html']);

export function generateLocalSecret() {
  return crypto.randomBytes(32).toString('hex');
}

export function safeTokenEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (!provided || !expected) return false;
  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function isAllowedLocalHost(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw || /[\s/\\@,]/.test(raw)) return false;
  const match = raw.match(/^(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/);
  if (!match) return false;
  if (match[2] !== undefined) {
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  }
  return true;
}

export function isSameLocalOrigin(originHeader, hostHeader) {
  if (!originHeader || !isAllowedLocalHost(hostHeader)) return false;
  try {
    const parsed = new URL(String(originHeader).trim());
    if (parsed.protocol !== 'http:' || parsed.username || parsed.password) return false;
    return parsed.host.toLowerCase() === String(hostHeader).trim().toLowerCase();
  } catch {
    return false;
  }
}

export function isSameLocalReferer(refererHeader, hostHeader) {
  if (!refererHeader || !isAllowedLocalHost(hostHeader)) return false;
  try {
    const parsed = new URL(String(refererHeader).trim());
    if (parsed.protocol !== 'http:' || parsed.username || parsed.password) return false;
    return parsed.host.toLowerCase() === String(hostHeader).trim().toLowerCase();
  } catch {
    return false;
  }
}

export function parseCookieHeader(cookieHeader) {
  const result = {};
  for (const part of String(cookieHeader || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) result[name] = value;
  }
  return result;
}

export function isPrivilegedApiRoute(pathname, method = 'GET') {
  const upperMethod = String(method || 'GET').toUpperCase();
  return PRIVILEGED_COOKIE_ROUTES.has(pathname) && !SAFE_METHODS.has(upperMethod);
}

function writeJsonError(res, status, code, message) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ok: false, code, error: message, message }));
}

function appendSetCookie(res, cookieValue) {
  const existing = res.getHeader?.('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookieValue);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieValue]);
  } else {
    res.setHeader('Set-Cookie', [String(existing), cookieValue]);
  }
}

function readHeader(req, name) {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : (value ?? '');
}

/**
 * 本地 HTTP API 安全守卫中间件：
 * 1. Host 白名单校验（防 DNS Rebinding）
 * 2. Origin / Referer / Sec-Fetch-Site 同源校验（防跨站 CSRF / 跨端口访问）
 * 3. 会话鉴权：
 *    - 主进程特权路由（写入第三方账号 Cookie）强制校验 X-Orbit-Token
 *    - 普通 /api/* 路由（账号、歌单、音频流、歌词、登出）校验 X-Orbit-Token 或 HttpOnly SameSite=Strict 会话 Cookie
 */
export function createLocalApiGuard(options = {}) {
  const apiToken = options.apiToken || process.env.ORBIT_LOCAL_API_TOKEN || generateLocalSecret();
  const sessionToken = options.sessionToken || process.env.ORBIT_LOCAL_SESSION_TOKEN || generateLocalSecret();
  // Electron 桌面端由主进程直接将 orbit_session 注入主窗口 session，不通过 HTTP 页面响应外发 Cookie；
  // 纯浏览器开发模式下（未传入 ORBIT_LOCAL_SESSION_TOKEN）才在同源页面导航时下发 HttpOnly SameSite=Strict Cookie。
  const issueSessionCookie = options.issueSessionCookie ?? !Boolean(process.env.ORBIT_LOCAL_SESSION_TOKEN);

  function middleware(req, res, next) {
    const hostHeader = String(readHeader(req, 'host') || '').trim();
    if (!isAllowedLocalHost(hostHeader)) {
      return writeJsonError(res, 403, 'FORBIDDEN_HOST', '仅允许从本地回环地址访问 ORBIT 服务');
    }

    let pathname = '/';
    try {
      pathname = new URL(req.originalUrl || req.url || '/', `http://${hostHeader}`).pathname;
    } catch {
      return writeJsonError(res, 400, 'INVALID_URL', '无效的请求路径');
    }

    const method = String(req.method || 'GET').toUpperCase();
    const originHeader = String(readHeader(req, 'origin') || '').trim();
    const refererHeader = String(readHeader(req, 'referer') || '').trim();
    const secFetchSite = String(readHeader(req, 'sec-fetch-site') || '').trim().toLowerCase();
    const secFetchMode = String(readHeader(req, 'sec-fetch-mode') || '').trim().toLowerCase();

    if (!pathname.startsWith('/api/')) {
      if (originHeader && !isSameLocalOrigin(originHeader, hostHeader)) {
        return writeJsonError(res, 403, 'FORBIDDEN_ORIGIN', '拒绝跨源访问本地页面资源');
      }
      if (issueSessionCookie && method === 'GET' && PAGE_PATHS.has(pathname)) {
        const safeNavigation =
          (!secFetchSite || secFetchSite === 'same-origin' || secFetchSite === 'none') &&
          (!secFetchMode || secFetchMode === 'navigate');
        if (safeNavigation) {
          const cookies = parseCookieHeader(readHeader(req, 'cookie'));
          if (!safeTokenEqual(cookies[SESSION_COOKIE_NAME], sessionToken)) {
            appendSetCookie(
              res,
              `${SESSION_COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`,
            );
          }
        }
      }
      return next();
    }

    // 针对所有 /api/* 响应默认禁缓存并声明 Vary，防止敏感数据被误缓存
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin, Cookie');

    const providedToken = String(readHeader(req, API_TOKEN_HEADER) || '').trim();
    const hasValidApiToken = safeTokenEqual(providedToken, apiToken);

    if (originHeader && !isSameLocalOrigin(originHeader, hostHeader)) {
      return writeJsonError(res, 403, 'FORBIDDEN_ORIGIN', '拒绝跨源调用本地音乐接口');
    }

    if (hasValidApiToken) {
      return next();
    }

    // 特权路由（写入账号凭据）仅允许 Electron 主进程通过 X-Orbit-Token 调用
    if (isPrivilegedApiRoute(pathname, method)) {
      return writeJsonError(res, 401, 'UNAUTHORIZED_PRIVILEGED_API', '缺少有效的桌面主进程授权令牌');
    }

    if (secFetchSite && secFetchSite !== 'same-origin') {
      return writeJsonError(res, 403, 'FORBIDDEN_FETCH_SITE', '拒绝非同源上下文调用本地音乐接口');
    }

    if (refererHeader && !isSameLocalReferer(refererHeader, hostHeader)) {
      return writeJsonError(res, 403, 'FORBIDDEN_REFERER', '拒绝来自外部页面的本地接口请求');
    }

    if (!SAFE_METHODS.has(method)) {
      const hasSameOriginProof = Boolean(
        (originHeader && isSameLocalOrigin(originHeader, hostHeader)) ||
        secFetchSite === 'same-origin',
      );
      if (!hasSameOriginProof) {
        return writeJsonError(res, 403, 'FORBIDDEN_CSRF', '写操作缺少有效的同源请求证明');
      }
    }

    const cookies = parseCookieHeader(readHeader(req, 'cookie'));
    if (!safeTokenEqual(cookies[SESSION_COOKIE_NAME], sessionToken)) {
      return writeJsonError(res, 401, 'UNAUTHORIZED_LOCAL_API', '本地接口访问未授权，请通过 ORBIT 应用访问');
    }

    return next();
  }

  middleware.apiToken = apiToken;
  middleware.sessionToken = sessionToken;
  return middleware;
}
