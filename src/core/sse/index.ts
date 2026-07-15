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
