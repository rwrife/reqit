/**
 * Barrel for the request-chaining core module. Pure, VS Code-free surface
 * only — extension/CLI adapters must reuse these helpers rather than fork
 * the resolution behavior.
 */
export {
  parseJsonPath,
  evaluateJsonPath,
  queryJsonPath,
  type JsonPathSegment,
  type JsonPathParsed,
  type JsonPathError,
  type ParseJsonPathResult,
  type JsonPathResult,
} from './jsonpath.js';
export {
  parseChainReference,
  parseCaptureDirective,
  applyCapture,
  createChainStore,
  resolveChainText,
  resolveChainRequest,
  validateRequestNames,
  type ChainReference,
  type CaptureType,
  type ParsedCapture,
  type CaptureParseError,
  type AppliedCapture,
  type CaptureApplyError,
  type ChainStore,
  type ChainRequestRecord,
  type ChainResponseRecord,
  type ChainDiagnostic,
  type ChainSubstituteResult,
  type ChainRequestInput,
  type ChainRequestResult,
} from './resolver.js';
