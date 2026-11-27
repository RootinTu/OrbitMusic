export const DEFAULT_UPSTREAM_TIMEOUT_MS = 10000;
export const DEFAULT_STREAM_CONNECT_TIMEOUT_MS = 15000;

export class UpstreamRequestError extends Error {
  constructor(message, { status = 502, code = 'UPSTREAM_ERROR', isTimeout = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'UpstreamRequestError';
    this.status = status;
    this.code = code;
    this.isTimeout = isTimeout;
  }
}

function isTimeoutOrAbort(error) {
  return Boolean(
    error && (
      error.name === 'TimeoutError'
      || error.name === 'AbortError'
      || error.code === 'ABORT_ERR'
      || error.code === 20
    ),
  );
}

/**
 * 统一的上游短请求封装（JSON/文本/封面图片）：
 * 自动附加超时控制并将超时/网络异常映射为带状态码的 UpstreamRequestError。
 */
export async function fetchWithTimeout(
  url,
  options = {},
  { timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS, label = '上游音乐服务' } = {},
) {
  const effectiveTimeout = Math.max(500, Number(timeoutMs) || DEFAULT_UPSTREAM_TIMEOUT_MS);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    const timeoutErr = new Error('The operation was aborted due to timeout');
    timeoutErr.name = 'TimeoutError';
    controller.abort(timeoutErr);
  }, effectiveTimeout);
  const signal = options.signal
    ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([options.signal, controller.signal]) : options.signal)
    : controller.signal;

  try {
    return await fetch(url, { ...options, signal });
  } catch (error) {
    if (error instanceof UpstreamRequestError) throw error;
    if (timedOut || controller.signal.aborted || isTimeoutOrAbort(error)) {
      const seconds = Math.max(1, Math.round(effectiveTimeout / 1000));
      throw new UpstreamRequestError(`${label}请求超时（${seconds}s），请稍后重试`, {
        status: 504,
        code: 'UPSTREAM_TIMEOUT',
        isTimeout: true,
        cause: error,
      });
    }
    throw new UpstreamRequestError(`${label}网络连接失败，请稍后重试`, {
      status: 502,
      code: 'UPSTREAM_NETWORK_ERROR',
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 音频流专用请求封装：
 * 仅对「连接与响应头建立」施加超时，响应头到达后立即取消定时器避免切断长音频流；
 * 同时监听客户端断开事件，及时中止上游连接。
 */
export async function fetchStreamWithTimeout(
  url,
  options = {},
  { connectTimeoutMs = DEFAULT_STREAM_CONNECT_TIMEOUT_MS, label = '音源服务', clientRequest = null } = {},
) {
  const effectiveTimeout = Math.max(1000, Number(connectTimeoutMs) || DEFAULT_STREAM_CONNECT_TIMEOUT_MS);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, effectiveTimeout);

  const onClientClose = () => controller.abort();
  clientRequest?.once?.('close', onClientClose);

  const signal = options.signal
    ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([options.signal, controller.signal]) : controller.signal)
    : controller.signal;

  try {
    const response = await fetch(url, { ...options, signal });
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    clientRequest?.removeListener?.('close', onClientClose);
    if (error instanceof UpstreamRequestError) throw error;
    if (timedOut) {
      const seconds = Math.max(1, Math.round(effectiveTimeout / 1000));
      throw new UpstreamRequestError(`${label}响应超时（${seconds}s），请稍后重试`, {
        status: 504,
        code: 'UPSTREAM_TIMEOUT',
        isTimeout: true,
        cause: error,
      });
    }
    if (isTimeoutOrAbort(error)) {
      throw new UpstreamRequestError(`${label}请求已取消`, {
        status: 499,
        code: 'UPSTREAM_ABORTED',
        cause: error,
      });
    }
    throw new UpstreamRequestError(`${label}连接失败，请稍后重试`, {
      status: 502,
      code: 'UPSTREAM_NETWORK_ERROR',
      cause: error,
    });
  }
}

export function classifyUpstreamError(error, fallbackMessage = '上游音乐服务请求失败', defaultStatus = 502) {
  if (error instanceof UpstreamRequestError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (isTimeoutOrAbort(error)) {
    return { status: 504, code: 'UPSTREAM_TIMEOUT', message: `${fallbackMessage}（请求超时）` };
  }
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : defaultStatus;
  return {
    status,
    code: error?.code || 'UPSTREAM_ERROR',
    message: error?.message || fallbackMessage,
  };
}
