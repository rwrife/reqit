/**
 * Barrel for the SSE core module. Only pure, VS Code-free surface.
 */
export {
  SseParser,
  SseEventSchema,
  parseSse,
  type SseEvent,
} from './parser.js';
export {
  evaluateSseUntil,
  SseUntilGate,
  SseUntilInputSchema,
  type SseUntilContext,
  type SseUntilResult,
} from './until.js';
export {
  sseOptionsFromDirectives,
  isSseResponse,
  type SseDirectiveDiagnostic,
  type SseDirectivesResult,
} from './directives.js';
export {
  runSseTransport,
  runSseTransportWithReconnect,
  formatSseTranscriptLine,
  reconnectHeaders,
  clampRetryMs,
  SseTransportUserOptionsSchema,
  type SseTransportOptions,
  type SseTransportWithReconnectOptions,
  type SseTransportUserOptions,
  type SseTransportResult,
  type SseTransportWithReconnectResult,
  type SseReconnectConnectContext,
  type SseReconnectState,
  type SseStopReason,
  type SseEventMeta,
} from './transport.js';
export {
  buildSseTranscriptFileName,
  serializeSseTranscript,
  type SseTranscriptRecord,
} from './transcript.js';
