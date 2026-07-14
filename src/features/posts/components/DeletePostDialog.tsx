import { useState } from 'react';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '~/components/ui';

/** Confirmation string the user must type whenever any selected item has been sent/posted. */
const CONFIRM_WORD = 'DELETE';

export interface DeletePostDialogItem {
  title: string;
  /** Whether this specific post has been sent to parents (vs. still a draft/scheduled). */
  isPosted: boolean;
}

interface DeletePostDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Posts pending deletion. Empty array (or `open: false`) renders nothing. */
  items: DeletePostDialogItem[];
  onConfirm: () => Promise<void>;
  /** Disables the primary button while the delete request is in flight. */
  pending?: boolean;
}

function DeletePostDialog({
  open,
  onOpenChange,
  items,
  onConfirm,
  pending = false,
}: DeletePostDialogProps) {
  const [confirmInput, setConfirmInput] = useState('');

  if (!open || items.length === 0) return null;

  const count = items.length;
  const isBulk = count > 1;
  const postedCount = items.filter((i) => i.isPosted).length;
  const draftCount = count - postedCount;
  const allDrafts = postedCount === 0;
  const allPosted = draftCount === 0;

  // Any sent/posted content in the selection raises the friction bar for
  // the whole action, since deleting it also removes it from parents' apps.
  const requiresTypedConfirm = postedCount > 0;
  const canDelete = !requiresTypedConfirm || confirmInput === CONFIRM_WORD;

  const description = allDrafts
    ? isBulk
      ? `These ${count} drafts will be permanently removed. This cannot be undone.`
      : 'This draft will be permanently removed. This cannot be undone.'
    : allPosted
      ? isBulk
        ? `These ${count} posts have been sent to parents. Deleting them will remove them from the Parents Gateway app for everyone immediately. This cannot be undone.`
        : 'This post has been sent to parents. Deleting it will remove it from the Parents Gateway app for everyone immediately. This cannot be undone.'
      : `${postedCount} of these posts ${postedCount === 1 ? 'has' : 'have'} been sent to parents — deleting ${postedCount === 1 ? 'it' : 'them'} will remove ${postedCount === 1 ? 'it' : 'them'} from the Parents Gateway app for everyone immediately. The other ${draftCount} ${draftCount === 1 ? 'draft' : 'drafts'} will also be permanently removed. This cannot be undone.`;

  const confirmLabel = isBulk
    ? allDrafts
      ? `Delete ${count} drafts`
      : `Delete ${count} posts`
    : allDrafts
      ? 'Delete draft'
      : 'Delete for everyone';

  function handleOpenChange(next: boolean) {
    if (!next) setConfirmInput('');
    onOpenChange(next);
  }

  async function handleConfirm() {
    if (!canDelete || pending) return;
    await onConfirm();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isBulk ? `Delete ${count} posts?` : 'Delete post?'}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1 py-1">
          <p className="text-xs text-muted-foreground">{isBulk ? `Posts (${count})` : 'Post'}</p>
          {isBulk ? (
            <ul className="max-h-32 space-y-1 overflow-y-auto">
              {items.map((item, i) => (
                <li key={i} className="truncate text-sm font-medium">
                  {item.title || 'Untitled'}
                </li>
              ))}
            </ul>
          ) : (
            <p className="truncate text-sm font-medium">{items[0].title || 'Untitled'}</p>
          )}
        </div>

        {requiresTypedConfirm && (
          <div className="space-y-1.5">
            <Label htmlFor="delete-confirm">
              Type <span className="font-mono font-semibold">{CONFIRM_WORD}</span> to confirm
            </Label>
            <Input
              id="delete-confirm"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={CONFIRM_WORD}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={!canDelete || pending}>
            {pending ? 'Deleting…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { DeletePostDialog };
export type { DeletePostDialogProps };
