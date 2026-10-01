export type CoordinateSpace = "normalized" | "css" | "device-pixels";

export type ActionTarget = {
  ref: string;
  fingerprint?: string;
  role?: string;
  name?: string;
  viewportRevision?: number;
  viewportSignature?: string;
};

export type TargetActionFields = {
  /** A temporary reference returned by GET_TARGET_MAP. */
  ref?: string;
  /** Coordinates are normalized to 0..1000 unless a coordinate space is supplied. */
  x?: number;
  y?: number;
  coordinateSpace?: CoordinateSpace;
  coordinate_space?: "normalized_1000";
  viewportRevision?: number;
  viewport_revision?: number;
  viewportSignature?: string;
  fingerprint?: string;
  role?: string;
  name?: string;
  targetFingerprint?: string;
  targetRole?: string;
  targetName?: string;
  target?: ActionTarget;
  target_hint?: string;
  fallback?: boolean;
};

export type Action =
  | ({ type: "click"; description: string } & TargetActionFields)
  | ({ type: "type"; text: string; description: string; press_enter?: boolean } & TargetActionFields)
  | { type: "scroll"; direction: "up" | "down"; amount: number; description: string }
  | { type: "navigate"; url: string; description: string }
  | { type: "wait"; milliseconds: number; description: string }
  | { type: "request_user"; reason: string; description: string }
  | { type: "confirm_purchase"; summary: PurchaseSummary; description: string; x?: number; y?: number }
  | { type: "done"; summary?: string; final_overview?: string; description: string };

export type PurchaseSummary = {
  merchant?: string;
  item?: string;
  total?: string;
  currency?: string;
};

export type RunEvent = {
  kind: "status" | "action" | "approval" | "error" | "done";
  message: string;
  action?: Action;
  screenshot?: string;
  locked?: boolean;
  final_overview?: string;
};

export type WorkerMessage =
  | { type: "START_RUN"; task: string }
  | { type: "STOP_RUN" }
  | { type: "PAUSE_RUN" }
  | { type: "RESUME_RUN" }
  | { type: "APPEND_INSTRUCTION"; instruction: string }
  | { type: "APPROVE_ACTION" }
  | { type: "REJECT_ACTION" }
  | { type: "GET_STATE" };

export type WorkerState = {
  running: boolean;
  paused: boolean;
  locked: boolean;
};

export type TargetBounds = { x: number; y: number; width: number; height: number };

export type InteractiveTarget = {
  ref: string;
  role: string;
  name: string;
  id?: string;
  tag?: string;
  type?: string;
  placeholder?: string;
  value?: string;
  title?: string;
  className?: string;
  href?: string;
  snippet?: string;
  bounds: TargetBounds;
  fingerprint: string;
};

export type ViewportInfo = {
  width: number;
  height: number;
  devicePixelRatio: number;
  device_pixel_ratio: number;
  signature: string;
  revision: number;
};

export type TargetMapResponse = {
  ok: true;
  summary: string;
  targets: InteractiveTarget[];
  viewport: ViewportInfo;
  viewportSignature: string;
  viewportRevision: number;
  semantic_dom?: string;
  semanticDom?: string;
  /** Snake-case aliases are consumed by the extension worker/server contract. */
  target_map: { targets: InteractiveTarget[]; revision: number; viewport_signature: string; semantic_dom?: string };
  targetMap: { targets: InteractiveTarget[]; revision: number; viewport_signature: string; semantic_dom?: string };
  checks: { visibleOnly: true; coordinateSpace: "css"; devicePixelRatio: number };
};

export type BridgeErrorCode =
  | "TARGET_NOT_FOUND"
  | "TARGET_REVISION_REQUIRED"
  | "STALE_TARGET"
  | "TARGET_MISMATCH"
  | "INVALID_COORDINATES"
  | "NO_INTERACTIVE_TARGET"
  | "EXECUTION_FAILED";

export type BridgeError = {
  code: BridgeErrorCode;
  message: string;
  ref?: string;
  expected?: Record<string, string | number>;
  actual?: Record<string, string | number>;
};

export type ActionResponse =
  | { ok: true; summary: string; checks: Record<string, string | number | boolean> }
  | { ok: false; summary: string; reason: string; error: BridgeError; checks: Record<string, string | number | boolean> };
