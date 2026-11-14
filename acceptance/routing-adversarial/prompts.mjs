/**
 * Adversarial routing set (M4). Separately scored from the 40-prompt baseline (PR #84).
 *
 * Two sets, scored separately:
 *   DEV      - used to find failures and to tune the fix.
 *   HOLDOUT  - written before any fix and never used to tune it; if a fix only helps DEV, HOLDOUT shows it.
 *              (Same author as DEV: it limits overfitting to named examples, it is not an independent audit.)
 *
 * Workspace seed (created by the runner): rw/inbox (3 files), events (2), calendar (4), models (5), notifications (1),
 * docs/notes.txt ("status: green; room 4417").
 *
 * Fields
 *   route   'model' (default) | 'shortcut:<topic>'   which path must answer
 *   g       groups that must be offered on a model turn (relevant-group recall)
 *   x       groups that must NOT be offered (unintended exposure of external or privacy-relevant tools)
 *   tool    {name,args} an honest model would call; the scripted model calls it when it is offered
 *   ok      regex the reply must match to count as a verified completion (disk truth), when `tool` is set
 *   seed    'prev-fs' | 'build-task'  conversation state to set up first
 */
const L = (dir, ok, x = ['email', 'calendar']) => ({ tool: { name: 'list_directory', args: { dirPath: `{ws}/${dir}` } }, ok, x });
const N = (n) => new RegExp(`"fileCount":\\s*${n}\\b`);

export const DEV = [
  { id: 'D01', cat: 'folder-vs-gmail', text: 'How many files are in the rw/inbox folder?', ...L('rw/inbox', N(3)) },
  { id: 'D02', cat: 'folder-vs-calendar', text: 'How many files are in the events folder?', ...L('events', N(2)) },
  { id: 'D03', cat: 'folder-vs-calendar', text: 'List the files in the calendar directory', ...L('calendar', N(4)) },
  { id: 'D04', cat: 'windows-path', text: 'Read {wsWin}\\docs\\notes.txt and tell me the room number', tool: { name: 'read_file', args: { filePath: '{ws}/docs/notes.txt' } }, ok: /4417/, x: ['email', 'calendar'] },
  { id: 'D05', cat: 'folder-vs-models', text: "What's in the models folder?", ...L('models', N(5)) },
  { id: 'D06', cat: 'js-events', text: 'Why does my JavaScript click event handler fire twice?', x: ['calendar', 'email'] },
  { id: 'D07', cat: 'programming-terms', text: 'Add an event listener for the inbox button in my React component', x: ['calendar', 'email'] },
  { id: 'D08', cat: 'programming-terms', text: "What does the events.on('mail') callback do in Node?", x: ['email', 'calendar'] },
  { id: 'D09', cat: 'quoted', text: 'Translate the sentence "check my Gmail inbox for invoices" into German', x: ['email'] },
  { id: 'D10', cat: 'negated', text: "Don't check my email or calendar, just tell me what 2+2 is", x: ['email', 'calendar'] },
  { id: 'D11', cat: 'no-tool', text: 'Explain the difference between Gmail labels and folders in general terms', x: ['email'] },
  { id: 'D12', cat: 'genuine-gmail', text: 'Show my unread emails from today', g: ['email'] },
  { id: 'D13', cat: 'genuine-calendar', text: 'What meetings do I have tomorrow?', g: ['calendar'] },
  { id: 'D14', cat: 'multi-group', text: 'Check my calendar for Friday and draft an email to Sam about the meeting', g: ['calendar', 'email'] },
  { id: 'D15', cat: 'web-vs-browser', text: 'Search the web for the latest Node LTS version', g: ['web'], x: ['browser'] },
  { id: 'D16', cat: 'web-vs-browser', text: 'Open https://example.com in the browser and tell me the page title', g: ['browser'] },
  { id: 'D17', cat: 'german', text: 'Wie viele Dateien sind im Ordner rw/inbox?', ...L('rw/inbox', N(3)) },
  { id: 'D18', cat: 'german', text: 'Zeig mir meine ungelesenen E-Mails', g: ['email'] },
  { id: 'D19', cat: 'german', text: 'Welche Termine habe ich morgen im Kalender?', g: ['calendar'] },
  { id: 'D20', cat: 'genuine-status', text: 'How far along is the Gmail organization?', route: 'shortcut:gmail' },
  { id: 'D21', cat: 'genuine-status', text: 'Is the inbox cleanup finished yet?', route: 'shortcut:gmail' },
  { id: 'D22', cat: 'gmail-count', text: 'How many emails are in my inbox?', g: ['email'] },
  { id: 'D23', cat: 'competing-routers', text: 'What is the status of the file sync in the mail folder?', x: ['email'] },
  { id: 'D24', cat: 'competing-routers', text: 'Status of the rw/inbox folder?', ...L('rw/inbox', N(3)) },
  { id: 'D25', cat: 'shortcut-reminders', text: 'Show my reminders', route: 'shortcut:reminders' },
  { id: 'D26', cat: 'reminders', text: 'Remind me to call mom at 6pm', g: ['reminders'] },
  { id: 'D27', cat: 'shortcut-notifications', text: 'What are my notification settings?', route: 'shortcut:notifications' },
  { id: 'D28', cat: 'competing-routers', text: 'How many files are in the notifications folder?', ...L('notifications', N(1)) },
  { id: 'D29', cat: 'follow-up', seed: 'prev-fs', text: 'and how many in events?', ...L('events', N(2)) },
  { id: 'D30', cat: 'follow-up', seed: 'build-task', text: 'Status?', route: 'shortcut:conversation_task' },
  { id: 'D31', cat: 'filename', text: 'Is my inbox.json file still there?', x: ['email'] },
  { id: 'D32', cat: 'follow-up', text: 'Status?', route: 'model' },
];

export const HOLDOUT = [
  { id: 'H01', cat: 'folder-vs-gmail', text: 'Count the files inside rw\\inbox please.', ...L('rw/inbox', N(3)) },
  { id: 'H02', cat: 'folder-vs-calendar', text: 'Which files are in my events directory?', ...L('events', N(2)) },
  { id: 'H03', cat: 'folder-vs-models', text: 'how many items are in the models folder', ...L('models', N(5)) },
  { id: 'H04', cat: 'windows-path', text: 'Is there a notes.txt in docs, and what room does it mention?', tool: { name: 'read_file', args: { filePath: '{ws}/docs/notes.txt' } }, ok: /4417/, x: ['email', 'calendar'] },
  { id: 'H05', cat: 'german', text: 'Wie viele Dateien liegen im Ordner calendar?', ...L('calendar', N(4)) },
  { id: 'H06', cat: 'gmail-count', text: 'How many messages are in my inbox right now?', g: ['email'] },
  { id: 'H07', cat: 'genuine-status', text: 'Has the Gmail labelling job finished?', route: 'shortcut:gmail' },
  { id: 'H08', cat: 'genuine-status', text: 'Any progress on organizing my email?', route: 'shortcut:gmail' },
  { id: 'H09', cat: 'negated', text: "Please don't summarize my inbox, I only want to know what a MIME type is", x: ['email'] },
  { id: 'H10', cat: 'programming-terms', text: 'In my code, `inbox.on("mail", fn)` is not firing. Why?', x: ['email', 'calendar'] },
  { id: 'H11', cat: 'genuine-calendar', text: 'When is my next dentist appointment?', g: ['calendar'] },
  { id: 'H12', cat: 'web-vs-browser', text: 'Look up the current price of a Raspberry Pi 5 online', g: ['web'] },
  { id: 'H13', cat: 'web-vs-browser', text: 'Click the login button on the open page and fill in the form', g: ['browser'] },
  { id: 'H14', cat: 'multi-group', text: 'Send an email to anna@example.com and add the call to my calendar', g: ['email', 'calendar'] },
  { id: 'H15', cat: 'no-tool', text: 'What status does HTTP 404 mean?', x: ['email', 'calendar'] },
  { id: 'H16', cat: 'filename', text: 'How much is left of the quarterly mail merge file mail_merge_q3.xlsx?', x: ['email'] },
  { id: 'H17', cat: 'shortcut-notifications', text: 'Show me the update status of my notifications', route: 'shortcut:notifications' },
  { id: 'H18', cat: 'models', text: 'Which models are installed?', g: ['models'] },
  { id: 'H19', cat: 'follow-up', text: 'Status?', route: 'model' },
  { id: 'H20', cat: 'german', text: 'Zähle die Dateien im Ordner rw/inbox', ...L('rw/inbox', N(3)) },
  { id: 'H21', cat: 'folder-vs-calendar', text: 'list everything in events/ then tell me which is newest', ...L('events', N(2)) },
];
