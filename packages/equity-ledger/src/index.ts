/**
 * @cag/equity-ledger — a books-and-records engine for B20 positions.
 *
 * Not a tax engine. It records what moved, in which units, with which evidence, and is
 * deliberately unable to answer questions it has no evidence for. Jurisdictional accounting
 * method, cost basis across an unproven ownership link, return of capital, withholding and
 * dividend basis all stay MANUAL/UNKNOWN until structured evidence exists.
 */

export {
  ACCOUNT_KINDS,
  CLASSIFICATION_STATUSES,
  ENTRY_KINDS,
  LEDGER_VIOLATIONS,
  accountKey,
  assertBalanced,
  buildCorrection,
  buildRestatement,
  checkConservation,
  dedupeEntries,
  movementIdentity,
  projectPositions,
  type AccountKind,
  type BalanceReport,
  type ClassificationStatus,
  type ConservationReport,
  type EntryKind,
  type LedgerAccount,
  type LedgerEntry,
  type LedgerViolation,
  type Position,
  type Posting,
} from './postings.js';
