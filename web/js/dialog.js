// The one confirmation dialog: the same card as the screen's Disconnected
// message, shown modally over everything (including Settings).

const $ = (id) => document.getElementById(id);

/**
 * Asks a question and resolves to true when the user confirms.
 * @param {{title: string, body?: string, confirm?: string, cancel?: string}} opts
 */
export function ask({ title, body = '', confirm = 'OK', cancel = 'Cancel' }) {
  const dialog = $('confirm');
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-ok').textContent = confirm;
  $('confirm-cancel').textContent = cancel;
  dialog.returnValue = '';
  dialog.showModal();
  $('confirm-ok').focus();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

// A tap on the backdrop cancels.
$('confirm').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close('cancel');
});
