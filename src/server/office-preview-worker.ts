import { convert } from './office-preview.js';

type Request = { source?: unknown; extension?: unknown };

process.on('message', async (message: Request) => {
  const source = typeof message?.source === 'string' ? message.source : '';
  const extension = typeof message?.extension === 'string' ? message.extension : '';
  try {
    const pdf = await convert(source, extension);
    await new Promise<void>(resolve => process.send?.({ pdf: pdf.toString('base64') }, () => resolve()) ?? resolve());
  } catch (error) {
    const value = error as Error & { status?: number };
    await new Promise<void>(resolve => process.send?.({
      error: value.message || '文档预览失败，请下载原文件。',
      status: Number.isInteger(value.status) ? value.status : 422
    }, () => resolve()) ?? resolve());
  } finally {
    process.disconnect();
  }
});
