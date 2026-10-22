// ==============================================================================
// apiService.ts - HomestayMobileApp (React Native / Expo SDK 57)
// ==============================================================================
// Client networking service for dispatching document captures to the remote
// Dell Micro edge server over Cloudflare Tunnel (https://api.theasymptotebrief.com).
// Secured with pre-shared Bearer token authentication matching PassportReadAPI.
// Uses expo-file-system/legacy to ensure FileSystemUploadType.MULTIPART compiles
// cleanly on modern Expo SDK 57 without native FormDataPart bridge crashes.
//
// Key Features:
// - Task 42: Dual Visa Support (visa_document vs visa_stamp)
// - Task 44: Mobile-Triggered Deletion (deleteJob cascade purge)
// - Exports submitGuestDocuments for syncManager compatibility
// ==============================================================================

import * as FileSystem from 'expo-file-system/legacy';

// ------------------------------------------------------------------------------
// Configuration: Production endpoint and pre-shared Bearer Token
// ------------------------------------------------------------------------------

const DEFAULT_API_BASE_URL = 'https://api.theasymptotebrief.com/api/v1';
const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || DEFAULT_API_BASE_URL;

const DEFAULT_BEARER_TOKEN = '388f64ef3bea954970952b97a477e9822aaf4c2fad7d3b046caf8df82a224f88';
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
  created_at?: string;
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

export interface JobDeleteResponse {
  job_id: string;
  status: string;
  purged_disk_files: number;
  message?: string;
}

export type DocumentAttachmentType =
  | 'visa_document'
  | 'visa_stamp'
  | 'visa_page'
  | 'entry_stamp'
  | 'welcome_form'
  | 'guest_photo';

/**
 * Initializes a new document extraction job by uploading the primary passport bio image.
 * Maps to POST /api/v1/jobs/submit with multipart form data and Bearer Authorization.
 *
 * @param passportBioUri - Local file URI for the captured passport bio page.
 * @returns Promise resolving to the created job identifier and initial status.
 */
export const submitPassportBio = async (passportBioUri: string): Promise<CreateJobResponse> => {
  const uploadUrl = `${API_BASE_URL}/jobs/submit`;

  const uploadResult = await FileSystem.uploadAsync(uploadUrl, passportBioUri, {
    fieldName: 'passport_bio',
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    headers: {
      'Accept': 'application/json',
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
 * @param jobId - Unique job UUID returned from submitPassportBio.
 * @param docType - Supported document type ('visa_document', 'visa_stamp', 'visa_page', 'entry_stamp', 'welcome_form', or 'guest_photo').
 * @param fileUri - Local filesystem URI of the image to attach.
 */
export const attachDocumentToJob = async (
  jobId: string,
  docType: DocumentAttachmentType,
  fileUri: string
): Promise<void> => {
  const attachUrl = `${API_BASE_URL}/jobs/${jobId}/attach/${docType}`;

  const uploadResult = await FileSystem.uploadAsync(attachUrl, fileUri, {
    fieldName: 'file',
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${API_BEARER_TOKEN}`,
    },
  });

  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    throw new Error(`Failed to attach ${docType} to job ${jobId}: ${uploadResult.body}`);
  }
};

export const attachDocument = attachDocumentToJob;

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
    console.warn(`[API] Start job returned HTTP ${response.status}: ${errorText}`);
  }
};

/**
 * Convenience multi-document dispatcher used by syncManager.
 * Ingests passport bio, sequentially attaches all available document images,
 * and starts the worker.
 */
export const submitGuestDocuments = async (
  passportBioPath: string,
  visaPath?: string,
  entryStampPath?: string,
  formCPath?: string,
  reference?: string
): Promise<CreateJobResponse> => {
  // 1. Submit passport bio to initialize the job on Dell server
  const jobRes = await submitPassportBio(passportBioPath);
  const jobId = jobRes.job_id;

  // 2. Attach optional secondary captures
  if (visaPath) {
    await attachDocumentToJob(jobId, 'visa_page', visaPath);
  }
  if (entryStampPath) {
    await attachDocumentToJob(jobId, 'entry_stamp', entryStampPath);
  }
  if (formCPath) {
    await attachDocumentToJob(jobId, 'welcome_form', formCPath);
  }

  // 3. Trigger background queue worker
  await startJobProcessing(jobId);

  return jobRes;
};

/**
 * Polls the current state and partial/final extracted results of a specific job.
 * Maps to GET /api/v1/jobs/{job_id} with Bearer Authorization.
 *
 * @param jobId - Unique job tracking UUID.
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

export const pollJobStatus = getJobStatus;

/**
 * Permanently deletes a submission and purges all persisted images from the Dell edge server.
 * Implements Task 44 (Mobile-Triggered Deletion Flow).
 * Maps to DELETE /api/v1/jobs/{job_id} with Bearer Authorization.
 *
 * @param jobId - The UUID of the job to purge on the remote server.
 */
export const deleteJob = async (jobId: string): Promise<JobDeleteResponse> => {
  const deleteUrl = `${API_BASE_URL}/jobs/${jobId}`;

  const response = await fetch(deleteUrl, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Server deletion failed for job ${jobId} (HTTP ${response.status}): ${errBody}`);
  }

  return response.json();
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