import { isAllowedRpcMethod, rpcMethods } from './rpc-methods.js';

export function needsActionIdentity(method: string): boolean {
  return isAllowedRpcMethod(method) && rpcMethods[method] === 'write' &&
    method !== 'thread/resume' && method !== 'thread/unsubscribe';
}
