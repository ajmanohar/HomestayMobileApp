// ==============================================================================
// apiService.ts - HomestayMobileApp (React Native / Expo)
// ==============================================================================
// Client networking service for dispatching document captures to the remote
// Dell Micro edge server over Cloudflare Tunnel (https://api.theasymptotebrief.com)
// Secured with pre-shared Bearer token authentication matching PassportReadAPI.
// ==============================================================================

import * as FileSystem from 'expo-file-system';

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
 * Common HTTP headers dictionary for JSON endpoints requiring Bearer authentication.
 */
const getAuthHeaders = (): Record<string, string> => {
  return {
    'Accept': 'application/json',
    'Authorization': `Bearer ${API_BEARER_TOKEN}`,
  };
};

// ------------------------------------------------------------------------------
// Job Submission & Attachment Types
// ------------------------------------------------------------------------------

export interface CreateJobResponse {
  job_id: string;
  status: string;
  message?: string;
}

export interface JobStatusResponse {
  job_id: string;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  result?: Record<string, any>;
  error_message?: string | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * Initializes a new document extraction job by uploading the primary passport bio image.
 * Maps to POST /api/v1/jobs/submit with multipart form data and Bearer Authorization.
 *
 * @param passportBioUri Local file URI for the captured passport bio page.
 * @returns Promise resolving to the created job identifier and initial status.
 */
export const submitPassportBio = async (passportBioUri: string): Promise<CreateJobResponse> => {
  const uploadUrl = `${API_BASE_URL}/jobs/submit`;

  // Use Expo FileSystem to upload multipart file with Bearer Authorization header
  const uploadResult = await FileSystem.uploadAsync(uploadUrl, passportBioUri, {
    fieldName: 'passport_bio',
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    headers: {
      'Authorization': `Bearer ${API_BEARER_TOKEN}`,
    },
  });

  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    throw new Error(`Job submission failed with status ${uploadResult.status}: ${uploadResult.body}`);
  }

  const parsedBody: CreateJobResponse = JSON.parse(uploadResult.body);
  return parsedBody;
};

/**
 * Attaches a secondary document image to an existing background extraction job.
 * Maps to POST /api/v1/jobs/{job_id}/attach/{doc_type} with Bearer Authorization.
 *
 * @param jobId Unique job UUID returned from submitPassportBio.
 * @param docType Supported document type ('visa_page', 'entry_stamp', 'welcome_form', or 'guest_photo').
 * @param fileUri Local filesystem URI of the image to attach.
 */
export const attachDocumentToJob = async (
  jobId: string,
  docType: 'visa_page' | 'entry_stamp' | 'welcome_form' | 'guest_photo',
  fileUri: string
): Promise<void> => {
  const attachUrl = `${API_BASE_URL}/jobs/${jobId}/attach/${docType}`;

  const uploadResult = await FileSystem.uploadAsync(attachUrl, fileUri, {
    fieldName: 'file',
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    headers: {
      'Authorization': `Bearer ${API_BEARER_TOKEN}`,
    },
  });

  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    throw new Error(`Failed to attach ${docType} to job ${jobId}: ${uploadResult.body}`);
  }
};

/**
 * Signals the server worker that all document uploads are complete and processing may begin.
 * Maps to POST /api/v1/jobs/{job_id}/start with Bearer Authorization.
 *
 * @param jobId Target job tracking UUID.
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
 * Polls the current state and partial/final extracted results of a specific job.
 * Maps to GET /api/v1/jobs/{job_id} with Bearer Authorization.
 *
 * @param jobId Unique job tracking UUID.
 * @returns Promise resolving to the current job record including status and extracted fields.
 */
export const getJobStatus = async (jobId: string): Promise<JobStatusResponse> => {
  const statusUrl = `${API_BASE_URL}/jobs/${jobId}`;

  const response = await fetch(statusUrl, {
    method: 'GET',
    headers: getAuthHeaders(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch status for job ${jobId} (HTTP ${response.status}): ${errorText}`);
  }

  const data: JobStatusResponse = await response.json();
  return data;
};

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