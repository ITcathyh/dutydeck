/**
 * 飞书图片附件按文件头识别真实格式。
 *
 * 下载接口回传的 contentType 与资源自带的文件名都可能与实际字节不符
 * （扩展名是 .jpg 的 GIF、服务端误标 image/jpeg 的 PNG），扩展名信任会让
 * 本地读取工具按错误格式解析。这里只读取有限长度的文件头做匹配，不做解码/转码。
 */

export interface DetectedImageFormat {
  extension: string;
  mimeType: string;
}

export function detectImageFormat(bytes: Uint8Array): DetectedImageFormat | undefined {
  // 仅匹配签名（6 字节）会把截断/伪造的短头误判成 GIF；完整文件头至少还要
  // 逻辑屏幕描述符（7 字节），与 botmux 同口径取 13。
  if (bytes.length >= 13 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) {
    return { extension: '.gif', mimeType: 'image/gif' };
  }
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { extension: '.png', mimeType: 'image/png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: '.jpg', mimeType: 'image/jpeg' };
  }
  if (bytes.length >= 16
    && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(bytes, 12, 16))) {
    return { extension: '.webp', mimeType: 'image/webp' };
  }
  return undefined;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString('ascii');
}

/**
 * GIF 可能包含多帧，单帧预览只能看到其中一帧。提示 Agent 按时间顺序查看/抽帧后
 * 再描述动作，不要把单帧当成完整内容。
 */
export function gifSequenceHint(mimeType: string | undefined): string | undefined {
  return mimeType === 'image/gif'
    ? '该 GIF 可能包含多帧，单张预览只能看到其中一帧；描述动作或用户操作前请按时间顺序查看或抽取各帧。'
    : undefined;
}
