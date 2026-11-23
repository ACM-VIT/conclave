export const APP_DOCUMENT_UPDATE_BUDGET = { capacity: 60, refillPerSec: 30 } as const;

export const APP_DOCUMENT_UPDATE_MAX_BYTES = 256 * 1024;

export const APP_DOCUMENT_UPLOADS_PER_SECOND = Math.floor((APP_DOCUMENT_UPDATE_BUDGET.refillPerSec * 2) / 3);

export const APP_DOCUMENT_UPLOAD_INTERVAL_MS = Math.ceil(1000 / APP_DOCUMENT_UPLOADS_PER_SECOND);
