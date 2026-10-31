import { authenticatedDevices, isPasswordConfigured, revokeAllDevices, revokeDevice, setPassword } from '../auth.js';

try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 16_384) throw new Error('本机请求过大。');
  }
  const request = JSON.parse(input) as { action: string; id?: string; password?: string };
  switch (request.action) {
    case 'list': break;
    case 'password':
      if (typeof request.password !== 'string' || request.password.length > 256) throw new Error('密码格式无效。');
      await setPassword(request.password);
      break;
    case 'revoke':
      if (typeof request.id !== 'string') throw new Error('请选择设备。');
      revokeDevice(request.id);
      break;
    case 'revoke-all': revokeAllDevices(); break;
    default: throw new Error('未知本机认证操作。');
  }
  process.stdout.write(JSON.stringify({ supported: true, passwordConfigured: isPasswordConfigured(), ...authenticatedDevices() }));
} catch {
  // Never echo request bodies or password values through command errors.
  process.stderr.write('本机认证操作未完成，请确认密码至少 6 位且认证记录可读写。');
  process.exitCode = 1;
}
