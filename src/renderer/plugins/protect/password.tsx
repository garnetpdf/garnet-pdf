import { useState } from 'react';
import type { PluginContext } from '../../plugin-host/types';
import { actions, saveProtection } from '../../actions';
import {
  ALL_PERMISSIONS,
  PERMISSION_KEYS,
  PERMISSION_LABELS,
  passwordProblem,
  permissionsToP,
  type Permissions,
} from '../../../engine/tools/security/permissions';
import { Check, errorText, openDialog } from './kit';

type Decision = NonNullable<ReturnType<typeof saveProtection.get>>;

const RESTRICTED_DEFAULT: Permissions = {
  ...ALL_PERMISSIONS,
  copy: false,
  edit: false,
  annotate: false,
  form: false,
  assemble: false,
};

/** Saves with a protection decision; restores the previous decision when the save does not happen. */
async function saveWith(ctx: PluginContext, docId: string, decision: Decision): Promise<boolean> {
  const previous = saveProtection.get(docId);
  saveProtection.set(docId, decision);
  let saved = false;
  const off = ctx.documents.subscribe('saved', (doc) => {
    if (doc.docId === docId) saved = true;
  });
  try {
    await actions.save?.();
  } catch (error) {
    ctx.ui.toast(errorText(error));
  } finally {
    off();
  }
  if (!saved) {
    if (previous) saveProtection.set(docId, previous);
    else saveProtection.delete(docId);
  }
  return saved;
}

/** Asks for the permissions (owner) password when the app cannot change protection on its own. */
async function ensureOwner(ctx: PluginContext, docId: string): Promise<boolean> {
  const status = await ctx.engine.call('security.status', { docId });
  if (status.canChangeProtection) return true;
  const password = await ctx.ui.prompt('Enter the permissions password to change protection');
  if (password === null) return false;
  if (await ctx.engine.call('security.checkOwnerPassword', { docId, password })) return true;
  ctx.ui.toast('That is not the permissions password for this document.');
  return false;
}

function AddPasswordForm({ close }: { close: (decision?: Decision) => void }) {
  const [requireOpen, setRequireOpen] = useState(true);
  const [open, setOpen] = useState('');
  const [openAgain, setOpenAgain] = useState('');
  const [restrict, setRestrict] = useState(false);
  const [owner, setOwner] = useState('');
  const [ownerAgain, setOwnerAgain] = useState('');
  const [permissions, setPermissions] = useState<Permissions>(RESTRICTED_DEFAULT);
  const [error, setError] = useState('');
  const submit = () => {
    if (!requireOpen && !restrict)
      return setError('Choose a password for opening, permissions, or both.');
    if (requireOpen) {
      if (!open) return setError('Enter a password for opening the document.');
      if (open !== openAgain) return setError('The open passwords do not match.');
      const problem = passwordProblem(open);
      if (problem) return setError(problem);
    }
    if (restrict) {
      if (!owner) return setError('Enter a permissions password.');
      if (owner !== ownerAgain) return setError('The permissions passwords do not match.');
      if (requireOpen && owner === open)
        return setError(
          'Use a different permissions password, or anyone who can open the file could remove the restrictions.',
        );
      const problem = passwordProblem(owner);
      if (problem) return setError(problem);
    }
    close({
      mode: 'set',
      userPassword: requireOpen ? open : '',
      ownerPassword: restrict ? owner : open,
      permissions: permissionsToP(restrict ? permissions : ALL_PERMISSIONS),
    });
  };
  return (
    <form
      className="p4b-form"
      data-testid="add-password-dialog"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <section className="p4b-section">
        <Check
          checked={requireOpen}
          onChange={setRequireOpen}
          label="Require a password to open the document"
        />
        {requireOpen && (
          <div className="p4b-grid-2">
            <input
              type="password"
              aria-label="Open password"
              placeholder="Password"
              autoComplete="new-password"
              value={open}
              onChange={(e) => setOpen(e.target.value)}
            />
            <input
              type="password"
              aria-label="Confirm open password"
              placeholder="Confirm password"
              autoComplete="new-password"
              value={openAgain}
              onChange={(e) => setOpenAgain(e.target.value)}
            />
          </div>
        )}
      </section>
      <section className="p4b-section">
        <Check
          checked={restrict}
          onChange={setRestrict}
          label="Restrict printing, copying and editing"
          help="A separate permissions password is needed to change these restrictions."
        />
        {restrict && (
          <>
            <div className="p4b-grid-2">
              <input
                type="password"
                aria-label="Permissions password"
                placeholder="Permissions password"
                autoComplete="new-password"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
              />
              <input
                type="password"
                aria-label="Confirm permissions password"
                placeholder="Confirm permissions password"
                autoComplete="new-password"
                value={ownerAgain}
                onChange={(e) => setOwnerAgain(e.target.value)}
              />
            </div>
            <div className="p4b-grid-2" role="group" aria-label="Allowed actions">
              {PERMISSION_KEYS.map((key) => (
                <Check
                  key={key}
                  checked={permissions[key]}
                  onChange={(value) => setPermissions({ ...permissions, [key]: value })}
                  label={PERMISSION_LABELS[key]}
                />
              ))}
            </div>
            <p className="p4b-hint">
              Restrictions are honoured by PDF readers that respect them. They do not stop
              determined copying.
            </p>
          </>
        )}
      </section>
      <p className="p4b-hint">
        The saved file is encrypted with AES 256-bit. You keep editing normally; encryption is
        applied when the file is saved.
      </p>
      {error && (
        <p className="p4b-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button type="button" onClick={() => close()}>
          Cancel
        </button>
        <button type="submit" className="primary">
          Protect and save
        </button>
      </footer>
    </form>
  );
}

export async function addPassword(ctx: PluginContext): Promise<void> {
  const doc = ctx.documents.active();
  if (!doc) return;
  const status = await ctx.engine.call('security.status', { docId: doc.docId });
  if (status.encrypted && !(await ensureOwner(ctx, doc.docId))) return;
  const decision = await openDialog<Decision>('Add password', (close) => (
    <AddPasswordForm close={close} />
  ));
  if (!decision) return;
  if (await saveWith(ctx, doc.docId, decision))
    ctx.ui.toast(`Password added. ${doc.name} is now encrypted.`);
}

export async function removePassword(ctx: PluginContext): Promise<void> {
  const doc = ctx.documents.active();
  if (!doc) return;
  const status = await ctx.engine.call('security.status', { docId: doc.docId });
  const pending = saveProtection.get(doc.docId);
  if (!status.encrypted && pending?.mode !== 'set') {
    ctx.ui.toast('This document has no password.');
    return;
  }
  if (status.encrypted && !(await ensureOwner(ctx, doc.docId))) return;
  if (
    !(await ctx.ui.confirm(
      'Remove the password and save? Anyone with the file will be able to open and change it.',
    ))
  )
    return;
  if (await saveWith(ctx, doc.docId, { mode: 'remove' }))
    ctx.ui.toast('Password removed. The saved file opens without a password.');
}
