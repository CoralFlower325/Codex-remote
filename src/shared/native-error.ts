export interface NativeTurnError {
  message: string;
  codexErrorInfo?: string | Record<string, { httpStatusCode?: number; turnKind?: string }>;
  additionalDetails?: string;
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Project public error fields only; never forward arbitrary RPC result data. */
export function nativeTurnError(value: unknown): NativeTurnError | null {
  const source = object(value);
  if (!source || typeof source.message !== 'string') return null;
  const result: NativeTurnError = { message: source.message.slice(0, 32_768) };
  if (typeof source.additionalDetails === 'string') result.additionalDetails = source.additionalDetails.slice(0, 32_768);
  if (typeof source.codexErrorInfo === 'string') result.codexErrorInfo = source.codexErrorInfo.slice(0, 256);
  else {
    const info = object(source.codexErrorInfo);
    if (info) result.codexErrorInfo = Object.fromEntries(Object.entries(info).slice(0, 8).map(([key, value]) => {
      const entry = object(value);
      const code = entry?.httpStatusCode;
      return [key.slice(0, 256), {
        ...(Number.isInteger(code) && Number(code) >= 100 && Number(code) <= 599 ? { httpStatusCode: Number(code) } : {}),
        ...(typeof entry?.turnKind === 'string' ? { turnKind: entry.turnKind.slice(0, 256) } : {})
      }];
    }));
  }
  return result;
}

const labels: Record<string, string> = {
  rateLimitExceeded: '请求频率受限', usageLimitExceeded: '使用额度已达上限',
  sessionBudgetExceeded: '会话预算已达上限', contextWindowExceeded: '上下文已达上限',
  serverOverloaded: '模型服务繁忙', flexUnavailable: 'Flex 服务暂不可用',
  httpConnectionFailed: '模型请求连接失败', responseStreamConnectionFailed: '响应连接失败',
  responseStreamDisconnected: '响应连接中断', responseTooManyFailedAttempts: '多次尝试后失败',
  internalServerError: '模型服务内部错误', unauthorized: '模型认证失败', badRequest: '模型请求无效',
  sandboxError: '沙箱错误', threadRollbackFailed: '会话回退失败',
  activeTurnNotSteerable: '当前轮次无法追加指令', cyberPolicy: '请求受到安全策略限制',
  misalignmentPolicyViolation: '请求受到策略限制', tooManyDenials: '拒绝次数已达上限'
};
export function nativeErrorPresentation(error: NativeTurnError) {
  const info = error.codexErrorInfo;
  const kind = typeof info === 'string' ? info : info ? Object.keys(info)[0] : undefined;
  const code = typeof info === 'object' ? Object.values(info).find(value => value.httpStatusCode)?.httpStatusCode : undefined;
  return { title: kind && labels[kind] || 'Codex 运行错误', kind, httpStatusCode: code };
}

export interface NativeRpcFailure { message: string; code?: number; data?: NativeTurnError; }
export function nativeRpcFailure(value: unknown): NativeRpcFailure {
  const source = object(value);
  const message = typeof source?.message === 'string' ? source.message : String(value);
  const data = nativeTurnError({ ...object(source?.data), message });
  return { message, ...(typeof source?.code === 'number' ? { code: source.code } : {}),
    ...(data && (data.codexErrorInfo || data.additionalDetails) ? { data } : {}) };
}
export class NativeRpcError extends Error {
  code: number | undefined;
  data: NativeTurnError | undefined;
  constructor(value: unknown) {
    const failure = nativeRpcFailure(value);
    super(failure.message);
    this.code = failure.code;
    this.data = failure.data;
  }
}
export function nativeRpcErrorMessage(value: unknown): string {
  const failure = nativeRpcFailure(value);
  const presentation = failure.data && nativeErrorPresentation(failure.data);
  const suffix = [presentation?.kind ? presentation.title === 'Codex 运行错误' ? presentation.kind : presentation.title : '',
    presentation?.httpStatusCode ? `HTTP ${presentation.httpStatusCode}` : '',
    failure.code !== undefined ? `RPC ${failure.code}` : ''].filter(Boolean).join(' · ');
  return `${failure.message}${suffix ? ` (${suffix})` : ''}`;
}
