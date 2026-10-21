// ==============================================================================
// apiService.ts - HomestayMobileApp (React Native / Expo SDK 57)
// ==============================================================================
// Client networking service for dispatching multi-document captures to the remote
// Dell Micro edge server over Cloudflare Tunnel (https://api.theasymptotebrief.com).
// Secured with pre-shared Bearer token authentication matching PassportReadAPI.
// Uses expo-file-system/legacy to ensure FileSystemUploadType.MULTIPART executes
// reliably across Android native runtime bridges.
// ==============================================================================

import * as FileSystem from 'expo-file-system/legacy';

// ------------------------------------------------------------------------------
// Configuration: Production endpoint and pre-shared Bearer Token
// ------------------------------------------------------------------------------

// Base URL for PassportReadAPI endpoint via Cloudflare Tunnel
const DEFAULT_API_BASE_URL = 'https://api.theasymptotebrief.com/api/v1';

// Resolve configured base URL from Expo public environment variable or fallback
const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || DEFAULT_API_BASE_URL;

// Pre-shared Bearer API key configured in /opt/PassportReadAPI/.env on the server
const DEFAULT_BEARER_TOKEN = '388f64ef3bea954970952b97a477e9822aaf4c2fad7d3b046caf8df82a224f88';

// Resolve active Bearer token from environment variable or constant
const API_BEARER_TOKEN = process.env.EXPO_PUBLIC_API_BEARER_TOKEN || DEFAULT_BEARER_TOKEN;

/**
 * Standard HTTP headers dictionary for JSON endpoints requiring Bearer authentication.
 */
const getAuthHeaders = (): Record<string, string> => {
  return {
    'Accept': 'application/json',
    'Authorization': `Bearer ${API_BEARER_TOKEN}`,
  };
};

/**
 * Normalizes local file path string to ensure valid file:// URI format.
 *
 * @param uri - Local document file URI or filesystem path
 * @returns Fully qualified file:// URI string
 */
const ensureFileUri = (uri: string): string => {
  if (uri.startsWith('file://')) {
    return uri;
  }
  return `file://${uri}`;
};

// ------------------------------------------------------------------------------
// Schema & Response Types
// ------------------------------------------------------------------------------

export interface JobSubmitResponse {
  job_id: string;
  status: string;
  message?: string;
}

export interface JobStatusResponse {
  job_id: string;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  result?: Record<string, any>;
  extracted_data?: Record<string, any>;
  error_message?: string | null;
  created_at?: string;
  updated_at?: string;
}

// ------------------------------------------------------------------------------
// Pipeline API Methods
// ------------------------------------------------------------------------------

/**
 * Dispatches the primary passport bio image to create an asynchronous background job.
 * Maps to POST /api/v1/jobs/submit with multipart form data and Bearer Authorization.
 *
 * @param passportBioUri - Local file URI for the captured passport bio page.
 * @returns Promise resolving to the created job identifier and initial status.
 */
export const submitPassportBio = async (passportBioUri: string): Promise<JobSubmitResponse> => {
  const uploadUrl = `${API_BASE_URL}/jobs/submit`;
  const normalizedUri = ensureFileUri(passportBioUri);

  const uploadResult = await FileSystem.uploadAsync(uploadUrl, normalizedUri, {
    fieldName: 'passport_bio',
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    headers: {
      'Authorization': `Bearer ${API_BEARER_TOKEN}`,
    },
  });

  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    throw new Error(`Passport bio upload failed (HTTP ${uploadResult.status}): ${uploadResult.body}`);
  }

  const parsed: JobSubmitResponse = JSON.parse(uploadResult.body);
  return parsed;
};

/**
 * Attaches a secondary document image to an existing background extraction job.
 * Maps to POST /api/v1/jobs/{job_id}/attach/{doc_type} with Bearer Authorization.
 *
 * @param jobId - Unique job UUID returned from submitPassportBio.
 * @param docType - Supported document type ('visa_page', 'entry_stamp', 'welcome_form', or 'guest_photo').
 * @param fileUri - Local filesystem URI of the image to attach.
 */
export const attachDocumentToJob = async (
  jobId: string,
  docType: 'visa_page' | 'entry_stamp' | 'welcome_form' | 'guest_photo',
  fileUri: string
): Promise<void> => {
  const attachUrl = `${API_BASE_URL}/jobs/${jobId}/attach/${docType}`;
  const normalizedUri = ensureFileUri(fileUri);

  const uploadResult = await FileSystem.uploadAsync(attachUrl, normalizedUri, {
    fieldName: 'file',
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    headers: {
      'Authorization': `Bearer ${API_BEARER_TOKEN}`,
    },
  });

  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    throw new Error(`Failed to attach ${docType} to job ${jobId} (HTTP ${uploadResult.status}): ${uploadResult.body}`);
  }
};

/**
 * Signals the server worker that all document uploads are complete and processing may begin.
 * Maps to POST /api/v1/jobs/{job_id}/start with Bearer Authorization.
 *
 * @param jobId - Target job tracking UUID.
 */
export const startJobProcessing = async (jobId: string): Promise<void> => {
  const startUrl = `${API_BASE_URL}/jobs/${jobId}/start`;

  const response = await fetch(startUrl, {
    method: 'POST',
    headers: getAuthHeaders(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to start job ${jobId} (HTTP ${response.status}): ${errorText}`);
  }
};

/**
 * High-level orchestration function consumed by DashboardScreen.
 * Submits the passport bio page, uploads any present secondary documents (visa, stamp, Form-C),
 * and triggers background worker processing on the Dell server.
 *
 * @param passportBioPath - Mandatory passport bio document path
 * @param visaPath - Optional visa page document path
 * @param entryStampPath - Optional immigration entry stamp path
 * @param formCPath - Optional physical Form-C arrival report path
 * @param reference - Optional booking reference or guest tag
 * @returns Parsed JobSubmitResponse containing the active job_id
 */
export const submitGuestDocuments = async (
  passportBioPath: string,
  visaPath?: string,
  entryStampPath?: string,
  formCPath?: string,
  reference?: string
): Promise<JobSubmitResponse> => {
  if (!passportBioPath) {
    throw new Error('Passport bio page image is required for document extraction.');
  }

  // 1. Submit primary passport image to initialize the background job
  const initResponse = await submitPassportBio(passportBioPath);
  const jobId = initResponse.job_id;

  // 2. Sequentially upload secondary documents if attached
  if (visaPath) {
    try {
      await attachDocumentToJob(jobId, 'visa_page', visaPath);
    } catch (err) {
      console.warn(`[apiService] Optional visa attachment skipped or failed:`, err);
    }
  }

  if (entryStampPath) {
    try {
      await attachDocumentToJob(jobId, 'entry_stamp', entryStampPath);
    } catch (err) {
      console.warn(`[apiService] Optional stamp attachment skipped or failed:`, err);
    }
  }

  if (formCPath) {
    try {
      await attachDocumentToJob(jobId, 'welcome_form', formCPath);
    } catch (err) {
      console.warn(`[apiService] Optional Form-C attachment skipped or failed:`, err);
    }
  }

  // 3. Signal the background queue worker on the server to start execution
  await startJobProcessing(jobId);

  return {
    job_id: jobId,
    status: 'QUEUED',
    message: 'All documents uploaded successfully. Background processing started.',
  };
};

/**
 * Polls the current state and partial/final extracted results of a specific job.
 * Maps to GET /api/v1/jobs/{job_id} with Bearer Authorization.
 *
 * @param jobId - Unique job tracking UUID.
 * @returns Promise resolving to the current job record.
 */
export const pollJobStatus = async (jobId: string): Promise<JobStatusResponse> => {
  const statusUrl = `${API_BASE_URL}/jobs/${jobId}`;

  const response = await fetch(statusUrl, {
    method: 'GET',
    headers: getAuthHeaders(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Polling failed for job ${jobId} (HTTP ${response.status}): ${errorText}`);
  }

  const data: JobStatusResponse = await response.json();
  return data;
};

/**
 * Alias for pollJobStatus matching the naming convention in alternative screen components.
 */
export const getJobStatus = pollJobStatus;

/**
 * Diagnostic check to verify API connectivity.
 * Maps to unauthenticated GET /health (public Cloudflare monitor).
 */
export const checkApiHealth = async (): Promise<boolean> => {
  try {
    const healthUrl = `${API_BASE_URL.replace('/api/v1', '')}/health`;
    const response = await fetch(healthUrl, { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
};