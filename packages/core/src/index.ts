/** Alfred core: the world's event log, recoverable runs, notices and commands.
 * Moved out of Robin's extension/robin/alfred-core; it knows nothing about
 * HTTP, pages, engines or any particular module.
 */
export { openWorld, type Migration, type World } from "./world.ts";
export { CORE_MIGRATIONS, ACTORS, RUN_STATES, NOTICE_STATES, PROPOSAL_STATES } from "./schema.ts";
export { withCoreContext, withDefaultActor, coreContext, type Actor, type CoreContext } from "./context.ts";
export { newId } from "./ids.ts";
export {
  AREA_COLOURS, SAMPLE_AREAS, listAreas, isArea, areaName, describeAreas, unknownArea, addArea, updateArea, moveArea, deleteAreaRow, AreaError,
  type Area, type AreaColour,
} from "./areas.ts";
export {
  addPreference, describePreferences, listPreferences, removePreference, updatePreference, PreferenceError, MAX_PREFERENCE, MAX_PREFERENCES,
  type Preference,
} from "./preferences.ts";
export {
  recordDomainEvent, changedFields, listEvents, latestEventSeq, onEvents, lastChanges, lastChangesOf, listRunReceipts, listRunActivity, RunLeaseLostError,
  type CoreEvent, type EventInput, type EventQuery,
} from "./events.ts";
export {
  submitRun, claimNextRun, heartbeatRun, finishRun, requestCancel, resumeRun, sweepRuns, interruptOrphanedRuns,
  getRun, listRuns, conversationRuns, listAutomationRuns, conversationBefore, RunError, RUN_LEASE_MS, openRequest, answerRequest, runAnswers, PERMISSION_ANSWERS,
  type Run, type RunOutcome, type RunRequest, type RunState, type SubmitRunInput, type ViewContext, viewContext,
} from "./runs.ts";
export {
  getConversation, setArchivePlan, requireOpenSession, markConversationReplyRead, listConversations, listArchivedConversations, updateConversation, startSession, isSession, runInSession, sessionIds, sessionEvent, titleFrom, ConversationError, CONVERSATION_ID, CONVERSATION_MODEL, THINKING_LEVELS,
  sessionRoot, recordCommit, recordPublished, SPEEDS,
  type Conversation, type ThinkingLevel, type SessionWorktree, type Speed,
} from "./conversations.ts";
export {
  listNotices, undeliveredNotices, isOpen, claimNotice, releaseNotice, presentNotice, acknowledgeNotice, createNotice, NoticeStateError, WELCOME_HOLDER,
  type Notice, type NoticeState,
} from "./notices.ts";
export { runCommand, commandReplay, CommandConflictError } from "./commands.ts";
export { attends, decide, noticeClass, ATTENTION, NOTICE_CLASSES, type AttentionPolicy, type Decision, type NoticeClass, type Outlet } from "./attention.ts";
export {
  reportPresence, isReturn, PRESENCE_KINDS, RETURN_AFTER_MS, AWAY_RETURN_MS,
  type AwayDigest, type PresenceKind, type PresenceOptions, type PresenceResult,
} from "./presence.ts";
export {
  executeNextRun, createRunDrain, localDate,
  type EngineModel, type EnginePort, type EngineRequest, type ExecuteOptions, type ExternalHooks, type RunDrain, type TurnUsage, type LiveUpdate, type RunProfile, type RunTool, type RunToolContext, type Workspace, type FileChange, type Attachment,
} from "./executor.ts";
export {
  openProposal, getProposal, listOpenProposals, acceptProposal, declineProposal, supersedeProposal, amendProposal, expireProposals, ProposalStateError, PROPOSAL_TTL_MS,
  type Proposal, type ProposalState, type ProposalStep,
} from "./proposals.ts";
export { getSettings, updateSettings, userLocale, localeOf, LOCALES, LOCALE_TAGS, localeTag, acceptLanguage, SettingsError, type Locale, type PageLayout, type UserSettings } from "./settings.ts";
export {
  createAutomation, updateAutomation, deleteAutomation, getAutomation, listAutomations, fireDueAutomations, runAutomationNow, ensureTemplates,
  latestSlot, nextSlot, automationName, automationGoal, AutomationError, AUTOMATION_TEMPLATES, CATCH_UP_MS,
  type Automation, type AutomationView, type AutomationTemplate, type AutomationPatch, type NewAutomation, type Schedule,
} from "./automations.ts";
export { listProjects, getProject, addProject, trustProject, removeProject, ProjectError, PROJECT_ID, SESSION_MODES, type Project, type SessionMode } from "./projects.ts";
export { listDevices, pairDevice, deviceForToken, revokeDevice, requestDevAccess, setDeviceScope, hashToken, DeviceError, DEVICE_KINDS, DEVICE_SCOPES, type Device, type DeviceKind, type DeviceScope } from "./devices.ts";
export {
  addFile, getFile, listRunFiles, dropUnattachedFiles, fileName, FileError, FILE_KINDS, FILE_ID, MAX_FILES_PER_RUN, type FileInfo, type FileKind,
} from "./files.ts";
export { simpleCommand, commandAllowed, normalizeCommand, listCommandGrants, grantCommand, revokeCommand, type CommandGrant } from "./shell.ts";
export { defaultSecretStore, fileStore, keychainStore, type SecretStore } from "./secrets.ts";
export { tidyWorld, OUTPUT_DAYS, COMMAND_DAYS, type Upkeep } from "./upkeep.ts";
export {
  enqueueOutbound, claimOutbound, finishOutbound, retryOutbound, interruptOutbound, getOutbound, listOutbound, OUTBOUND_STATES, OUTBOUND_MAX_ATTEMPTS,
  type Outbound, type OutboundState,
} from "./outbound.ts";
