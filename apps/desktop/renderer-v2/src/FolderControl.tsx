import React, { useEffect, useRef, useState } from 'react';
import { api, errorText, type Snapshot } from './bridge';
import { Icon } from './ui';
import {
  ACCESS_LABEL, accessSentence, folderChip, folderName, grantNote, proposalActions, proposalFor, proposalProblem, recentChoices,
  type FolderProposal, type WorkspaceAccess,
} from './folderModel';

type Notice = { text: string; error?: boolean } | null;

/**
 * The workspace folder in the v2 chat: a chip under the message box with a menu (choose a folder, recent folders,
 * read-only or read and write, show in Explorer, stop using it), and the card that asks before a folder becomes the
 * workspace. The card comes from the menu, or from a message that names a folder by its full path; that message is
 * held until the person answers. Nothing changes until they choose. The host stores the choice and Core enforces it.
 */
export function useFolderControl(opts: {
  snapshot: Snapshot | null;
  refresh: () => void;
  onNotice: (n: Notice) => void;
  disabled: boolean;
  /** Sends a message that was held while the card asked about its folder. */
  onSendHeld: (text: string, voiceTurnId?: string) => Promise<void>;
  /** Puts a held message back in the message box (Edit message). */
  onRestoreText: (text: string) => void;
}) {
  const { snapshot, refresh, onNotice, disabled, onSendHeld, onRestoreText } = opts;
  const [menuOpen, setMenuOpen] = useState(false);
  const [proposal, setProposal] = useState<FolderProposal | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const workspace = snapshot?.workspace ?? (snapshot?.folder ? { folder: snapshot.folder, access: 'read_write' as const, grantedAt: null, source: 'picker' as const } : null);
  const running = Boolean(snapshot?.running);
  const chip = folderChip(workspace);
  const recent = recentChoices(snapshot?.recentWorkspaces, workspace);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setMenuOpen(false); chipRef.current?.focus(); } };
    // A click outside the chip and its menu closes the menu; so does resizing or scrolling the page under it.
    const outside = (e: Event) => !(e.target instanceof Node) || !wrapRef.current?.contains(e.target);
    const onDown = (e: MouseEvent) => { if (outside(e)) setMenuOpen(false); };
    const onScroll = (e: Event) => { if (outside(e)) setMenuOpen(false); };
    const onResize = () => setMenuOpen(false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [menuOpen]);

  /** Opens the menu against the window, above the chip when there is room (else below), never cut off. */
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const toggleMenu = () => {
    if (menuOpen) { setMenuOpen(false); return; }
    const r = chipRef.current?.getBoundingClientRect();
    if (r) {
      const width = Math.min(380, window.innerWidth - 32);
      const left = Math.max(16, Math.min(r.left, window.innerWidth - width - 16));
      const above = r.top - 64;
      const below = window.innerHeight - r.bottom - 16;
      setMenuStyle(above >= 360 || above >= below
        ? { position: 'fixed', left, width, bottom: window.innerHeight - r.top + 6, maxHeight: Math.max(160, above) }
        : { position: 'fixed', left, width, top: r.bottom + 6, maxHeight: Math.max(160, below) });
    }
    setMenuOpen(true);
  };

  const act = async (work: () => Promise<unknown>, done?: string) => {
    setSaving(true);
    onNotice(null);
    try { await work(); if (done) onNotice({ text: done }); } catch (err) { onNotice({ text: errorText(err), error: true }); } finally { setSaving(false); refresh(); }
  };

  /** Opens the card for a folder the person picked or chose from the recent list. */
  const propose = async (folder: string, source: 'picker' | 'recent', remembered: WorkspaceAccess | null) => {
    setMenuOpen(false);
    try {
      const check = await api.checkWorkspaceFolder(folder);
      setError('');
      setProposal(proposalFor(check, source, remembered));
    } catch (err) {
      onNotice({ text: errorText(err), error: true });
    }
  };

  const choose = async () => {
    setMenuOpen(false);
    try {
      const picked = await api.chooseFolder({ purpose: 'workspace' });
      if (!picked) return;
      const remembered = (snapshot?.recentWorkspaces ?? []).find((r) => r.folder.toLowerCase() === picked.folder.toLowerCase())?.access ?? null;
      await propose(picked.folder, 'picker', remembered);
    } catch (err) {
      onNotice({ text: errorText(err), error: true });
    }
  };

  /**
   * Before a message is sent: when it names a folder that is not the workspace, show the card and hold the message.
   * Returns true when the card is now asking (the caller must not send). A failed check never blocks the message.
   */
  const askAboutMention = async (text: string, voiceTurnId?: string): Promise<boolean> => {
    let mention: Awaited<ReturnType<typeof api.inspectFolderMention>> = null;
    try { mention = await api.inspectFolderMention(text); } catch { return false; }
    if (!mention) return false;
    setError('');
    setMenuOpen(false);
    setProposal(proposalFor(mention.check, 'chat', mention.rememberedAccess, { message: text, voiceTurnId }));
    return true;
  };

  const answer = async (choice: 'use' | 'skip' | 'cancel') => {
    const p = proposal;
    if (!p) return;
    if (choice === 'cancel') {
      setProposal(null);
      if (p.message) onRestoreText(p.message);
      return;
    }
    if (choice === 'skip') {
      setProposal(null);
      if (p.message) await onSendHeld(p.message, p.voiceTurnId);
      return;
    }
    const problem = proposalProblem(p);
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError('');
    try {
      await api.useWorkspace(p.folder, { read: p.read, write: p.write }, p.source);
      setProposal(null);
      refresh();
      onNotice({ text: `Workspace: ${p.folder} (${(p.write ? ACCESS_LABEL.read_write : ACCESS_LABEL.read).toLowerCase()}).` });
      if (p.message) await onSendHeld(p.message, p.voiceTurnId);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const chipEl = (
    <div className="folder-wrap" ref={wrapRef}>
      <button ref={chipRef} type="button" className={`folder-chip${chip.readOnly ? ' read-only' : ''}${workspace ? '' : ' none'}`} title={chip.title}
        aria-haspopup="dialog" aria-expanded={menuOpen} disabled={disabled} onClick={toggleMenu}>
        <Icon name="folder" size={16} />
        <span className="label">{chip.label}</span>
      </button>
      {menuOpen && (
        <div className="popover folder-menu" role="dialog" aria-label="Workspace folder" style={menuStyle}>
          <h2>WORKSPACE FOLDER</h2>
          {workspace ? (
            <div className="folder-current">
              <span className="path">{workspace.folder}</span>
              <span><strong>{ACCESS_LABEL[workspace.access]}.</strong> {accessSentence(workspace.access)}</span>
              {grantNote(workspace) && <span className="note">{grantNote(workspace)}</span>}
            </div>
          ) : (
            <div className="folder-current"><span>No folder. Pandesh can chat, but cannot open your files until you choose one.</span></div>
          )}
          {running && <div className="folder-current"><span className="note">A task is running. Folder changes wait until it finishes.</span></div>}
          <button type="button" className="menu-item" autoFocus disabled={running || saving} onClick={() => void choose()}>
            <span>{workspace ? 'Choose another folder…' : 'Choose a folder…'}</span><span className="sub">Pandesh asks what it may do there before using it</span>
          </button>
          {workspace && (workspace.access === 'read'
            ? <button type="button" className="menu-item" disabled={running || saving} onClick={() => void act(async () => { await api.setWorkspaceAccess('read_write'); setMenuOpen(false); }, `Pandesh may now ask to change files in ${folderName(workspace.folder)}. Each change still asks you first.`)}>
                <span>Allow writing</span><span className="sub">Create and change files and run programs here, each with your approval</span>
              </button>
            : <button type="button" className="menu-item" disabled={running || saving} onClick={() => void act(async () => { await api.setWorkspaceAccess('read'); setMenuOpen(false); }, `${folderName(workspace.folder)} is read-only for Pandesh from your next message.`)}>
                <span>Make read-only</span><span className="sub">Pandesh keeps reading here but changes nothing</span>
              </button>)}
          {workspace && (
            <button type="button" className="menu-item" onClick={() => void act(async () => { await api.openWorkspaceFolder(); setMenuOpen(false); })}>
              <span>Show in Explorer</span>
            </button>
          )}
          {workspace && (
            <button type="button" className="menu-item" disabled={running || saving} onClick={() => void act(async () => { await api.clearFolder(); setMenuOpen(false); }, 'No workspace folder. Pandesh can chat, but cannot open your files.')}>
              <span>Stop using this folder</span><span className="sub">Pandesh no longer reads or changes anything in it</span>
            </button>
          )}
          {recent.length > 0 && (
            <>
              <h2>RECENT</h2>
              {recent.map((r) => (
                <button key={r.folder} type="button" className="menu-item" disabled={running || saving} title={r.folder} onClick={() => void propose(r.folder, 'recent', r.access)}>
                  <span>{folderName(r.folder)}</span><span className="sub">{r.folder} · {ACCESS_LABEL[r.access].toLowerCase()}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );

  let cardEl: React.ReactNode = null;
  if (proposal) {
    const buttons = proposalActions(proposal);
    const usable = proposal.check.state === 'ok';
    const problem = usable ? proposalProblem(proposal) : null;
    cardEl = (
      <section className="approval folder-card" aria-label={usable ? 'Use this folder as the workspace?' : 'Pandesh cannot use this folder'}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); void answer('cancel'); } }}>
        <div className="approval-head">
          <span className={`dot ${usable ? 'attention' : 'danger'}`} aria-hidden="true" />
          <span className="title">{usable ? 'Needs your OK · Use this folder as the workspace?' : 'Pandesh can\'t use this folder'}</span>
        </div>
        <dl>
          <dt>Folder</dt><dd className="code">{proposal.folder}</dd>
          <dt>Now</dt><dd>{workspace ? `${workspace.folder} (${ACCESS_LABEL[workspace.access].toLowerCase()})` : 'No folder'}</dd>
          {proposal.message && <><dt>Your message</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{proposal.message.length > 300 ? `${proposal.message.slice(0, 300)}…` : proposal.message}</dd></>}
          {!usable && <><dt>Why</dt><dd>{proposal.check.reason}</dd></>}
          {usable && proposal.check.warning && <><dt>Note</dt><dd>{proposal.check.warning}</dd></>}
        </dl>
        {usable && (
          <fieldset className="folder-access">
            <legend>What Pandesh may do in this folder</legend>
            <label>
              <input type="checkbox" checked={proposal.read} onChange={(e) => setProposal({ ...proposal, read: e.target.checked, write: e.target.checked ? proposal.write : false })} />
              <span><strong>Read</strong> — open, list and search the files in this folder and its subfolders. A workspace needs it.</span>
            </label>
            <label className={proposal.read ? undefined : 'disabled'}>
              <input type="checkbox" checked={proposal.write} disabled={!proposal.read} onChange={(e) => setProposal({ ...proposal, write: e.target.checked })} />
              <span><strong>Write</strong> — create and change files and run programs here. Each change is still shown to you for approval first.</span>
            </label>
          </fieldset>
        )}
        {(error || problem) && <p className="perm-error folder-error" role="alert">{error || problem}</p>}
        <div className="actions">
          {usable && <button type="button" className="btn primary" autoFocus disabled={saving || Boolean(problem)} onClick={() => void answer('use')}>{buttons.use}</button>}
          {buttons.skip && <button type="button" className="btn" autoFocus={!usable} disabled={saving} onClick={() => void answer('skip')}>{buttons.skip}</button>}
          <button type="button" className={buttons.skip || usable ? 'btn link' : 'btn'} disabled={saving} onClick={() => void answer('cancel')}>{buttons.cancel}</button>
        </div>
        <div className="foot">{usable ? 'Nothing changes until you choose. You can change this any time with the folder button under the message box.' : 'Nothing was changed.'}</div>
      </section>
    );
  }

  return { chip: chipEl, card: cardEl, asking: Boolean(proposal), askAboutMention };
}
