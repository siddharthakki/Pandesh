/**
 * One Outlook connector per Core process (one STA worker, one queue), shared by the Mail Hub routes and the Inbox
 * Assistant's evidence source. The index lives in Core's own database; both read it through the same MailIndex.
 */
import type { CoreDatabase } from '../../db/connection';
import { OutlookConnector } from './outlookConnector';
import { MailIndex } from './mailIndex';

let shared: { dataDir: string; connector: OutlookConnector } | null = null;

export function sharedOutlookConnector(dataDir: string): OutlookConnector {
  if (!shared || shared.dataDir !== dataDir) { shared?.connector.stop(); shared = { dataDir, connector: new OutlookConnector({ dataDir }) }; }
  return shared.connector;
}
export function mailIndexFor(db: CoreDatabase, dataDir: string): MailIndex { return new MailIndex(db, sharedOutlookConnector(dataDir)); }
export function stopMailHub(): void { shared?.connector.stop(); shared = null; }
