/** A profile photo when we are allowed to see one, else initials. */
export default function Avatar({
  name,
  src,
  size = 40,
}: {
  name: string;
  src?: string;
  size?: number;
}) {
  const initials =
    name
      .split(' ')
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?';
  const style = { width: size, height: size };
  return src ? (
    <img src={src} alt="" aria-hidden="true" style={style} className="shrink-0 rounded-full object-cover" />
  ) : (
    <div
      style={{ ...style, fontSize: Math.max(11, size * 0.35) }}
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full bg-panel-hover font-medium text-text-secondary"
    >
      {initials}
    </div>
  );
}

/** Square-crops and shrinks a picked image to a small JPEG data URL for a profile photo. */
export async function toAvatarDataUrl(file: File, edge = 256): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = edge;
  canvas.height = edge;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Cannot process that image');
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, edge, edge);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.82);
}
