export function isAbortError(error) {
  return Boolean(error && (error.name === 'AbortError' || error.code === 20));
}

/**
 * 单槽位异步请求控制器：
 * 新请求启动时自动 abort 同槽位上一笔未完成请求并递增序号，
 * 防止网络响应乱序回写 UI 或旧请求的 finally 误清当前加载态。
 */
export function createAsyncSlot() {
  let currentId = 0;
  let controller = null;

  return {
    start() {
      controller?.abort();
      currentId += 1;
      const activeController = new AbortController();
      controller = activeController;
      const id = currentId;
      const { signal } = activeController;
      return {
        id,
        signal,
        isCurrent: () => id === currentId && !signal.aborted,
        finish: () => {
          if (id !== currentId) return false;
          if (controller === activeController) controller = null;
          return true;
        },
      };
    },
    cancel() {
      currentId += 1;
      controller?.abort();
      controller = null;
    },
  };
}
