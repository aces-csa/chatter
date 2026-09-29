import type { LocalMessage } from '@/db/db';
import { canForward, copyText } from '@/lib/messageActions';
import { realtimeService } from '@/realtime/RealtimeService';
import { useUiStore } from '@/state/uiStore';

/** FR-3.12: select several messages, then copy, star, forward or delete them together. */
export default function SelectionBar({
  selected,
  nameOf,
}: {
  selected: LocalMessage[];
  nameOf: (userId: string) => string;
}) {
  const ui = useUiStore.getState;
  const forwardable = selected.length > 0 && selected.every(canForward);
  const copyable = selected.some((m) => !!m.body && !m.deletedForAll);

  const button = (label: string, onClick: () => void, disabled: boolean, path: string) => (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded-full p-2 text-text-secondary hover:bg-panel-hover disabled:opacity-30"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
        <path d={path} />
      </svg>
    </button>
  );

  return (
    <div className="flex items-center gap-2 border-t border-stroke bg-panel px-4 py-2.5">
      {button('Cancel selection', () => ui().setSelection(null), false,
        'M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z')}
      <span className="flex-1 text-sm">{selected.length} selected</span>
      {button('Star', () => void realtimeService.toggleStar(selected), selected.length === 0,
        'm12 17.3 6.2 3.7-1.6-7L22 9.2l-7.2-.6L12 2 9.2 8.6 2 9.2 7.4 14l-1.6 7z')}
      {button('Copy', () => {
        void navigator.clipboard?.writeText(copyText(selected.filter((m) => !m.deletedForAll), nameOf));
        ui().setSelection(null);
      }, !copyable, 'M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z')}
      {button('Forward', () => ui().setForwarding(selected), !forwardable,
        'M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11Z')}
      {button('Delete', () => ui().setDeleting(selected), selected.length === 0,
        'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z')}
    </div>
  );
}
