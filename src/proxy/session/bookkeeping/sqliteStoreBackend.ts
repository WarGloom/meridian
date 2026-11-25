import type { SessionStoreBackend } from "./storeBackend"
import { lookupSharedSessionResult, lookupSharedSessionByClaudeIdResult } from "./storeMappingsSql"
import { lookupPriorityAssignmentResult } from "./storePrioritySql"
import { readSessionStoreSnapshot, readSessionStoreGenerationSnapshot, readSessionTranscriptPins,
  lookupSessionRecovery, listStoredSessions } from "./storeMaintenanceSql"
import { storeSharedSession } from "./storeWriteSql"
import { isAgyAssignmentKey } from "./legacyCodec"
import { claimPriorityAttempt, releasePriorityAttempt, blockPriorityAttempt } from "./storeAttemptsSql"
import { storeSharedSessionAndPriorityAssignment } from "./storePublicationSql"
import { finalizeSharedSessionAndPriorityAssignment, rollbackSharedSessionAndPriorityAssignment } from "./storeSettlementSql"
import { attachSharedTranscriptLocator, evictSharedSession, clearSharedSessions } from "./storeMaintenanceWriteSql"
import { listSupersededProfileConversations, pruneSupersededProfileCopies } from "./storeProfileCopiesSql"

/** Explicit installation only; importing the JSON facade never activates or loads this backend. */
export const sqliteSessionStoreBackend: SessionStoreBackend = {
  lookupSharedSessionResult, lookupSharedSessionByClaudeIdResult, lookupPriorityAssignmentResult,
  readSessionStoreSnapshot, readSessionStoreGenerationSnapshot, readSessionTranscriptPins,
  lookupSessionRecovery, listStoredSessions,
  storeSharedSession: (directory, ...args) => isAgyAssignmentKey(args[0]) ? false : storeSharedSession(directory, ...args),
  claimPriorityAttempt, releasePriorityAttempt, blockPriorityAttempt,
  storeSharedSessionAndPriorityAssignment, finalizeSharedSessionAndPriorityAssignment,
  rollbackSharedSessionAndPriorityAssignment, attachSharedTranscriptLocator, evictSharedSession, clearSharedSessions,
  listSupersededProfileConversations, pruneSupersededProfileCopies,
}
