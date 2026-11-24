import { useRef, useState } from 'react';
import { BridgeGlassButton } from './BridgeGlassControls.jsx';

export default function MusicAccountAvatar({ profile }) {
  const fromWeChat = profile?.loginMethod === 'wechat';
  const local = typeof profile?.localAvatar === 'string' && profile.localAvatar.startsWith('data:image/jpeg;base64,')
    ? profile.localAvatar : '';
  const remoteSources = (fromWeChat ? [] : [profile?.avatar, profile?.avatarFallback])
    .filter(value => typeof value === 'string')
    .map(value => value.trim().replace(/^\/\//, 'https://'))
    .filter(value => /^(?:https?:\/\/|\/api\/)/i.test(value));
  const sources = [...new Set([local, ...remoteSources].filter(Boolean))];
  return <AvatarImage key={JSON.stringify(sources)} sources={sources} fallbackText={fromWeChat ? '微' : ''} />;
}

function AvatarImage({ sources, fallbackText }) {
  const [index, setIndex] = useState(0);
  const src = sources[index];
  if (!src) {
    return <span className={`music-account-avatar ${fallbackText ? 'is-initial' : 'is-fallback'}`} aria-hidden="true">
      {fallbackText}
    </span>;
  }
  return <img key={src} className="music-account-avatar" src={src} alt="" draggable={false}
    referrerPolicy="no-referrer" onError={() => setIndex(index + 1)} />;
}

async function prepareAvatar(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
    throw new Error('请选择不超过 8 MB 的 JPG、PNG 或 WebP 图片。');
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const { naturalWidth: width, naturalHeight: height } = image;
    const side = Math.min(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 160;
    const context = canvas.getContext('2d');
    context.fillStyle = '#16181c';
    context.fillRect(0, 0, 160, 160);
    context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, 160, 160);
    return canvas.toDataURL('image/jpeg', 0.89);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function MusicAccountAvatarPicker({ localAvatar, onChange, onError }) {
  const inputRef = useRef(null);
  const [saving, setSaving] = useState(false);
  async function pick(event) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setSaving(true);
    onError('');
    try {
      onChange(await prepareAvatar(file));
    } catch (error) {
      onError(error instanceof DOMException ? '无法读取或保存这张头像，请换一张图片。' : error.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <input type="file" ref={inputRef} hidden accept="image/jpeg,image/png,image/webp" onChange={pick} />
      <BridgeGlassButton disabled={saving} onClick={() => inputRef.current.click()}>
        {localAvatar ? '更换头像' : '设置头像'}
      </BridgeGlassButton>
    </>
  );
}
