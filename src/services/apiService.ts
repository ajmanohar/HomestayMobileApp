import * as FileSystem from 'expo-file-system/legacy';

/**
 * Production backend API endpoint served through Cloudflare Tunnel.
 */
const BASE_URL = 'https://api.theasymptotebrief.com/api/v1';

/**
 * Expected response structure when initiating an extraction job at /jobs/submit.
 */
export interface JobSubmitResponse {
  job_id: string;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  message?: string;
}

/**
 * Expected response structure when checking /jobs/{job_id}.
 */
export interface JobStatusResponse {
  job_id: string;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  result?: Record<string, any>;
  data?: Record<string, any>;
  extracted_data?: Record<string, any>;
  error_message?: string;
  error?: string;
}

/**
 * Helper to ensure a URI string has a valid file:// prefix for native Android file access.
 *
 * @param uri - Local file URI or path
 * @returns Standardized file:// URI
 */
const ensureFileUri = (uri: string): string => {
  if (uri.startsWith('file://')) {
    return uri;
  }
  return `file://${uri}`;
};

/**
 * Uploads an individual supplementary document to an existing job.
 * Uses native uploadAsync to bypass React Native Android OkHttp FormData issues.
 *
 * @param jobId - UUID of the active job
 * @param docType - Target attachment type ('visa_page', 'entry_stamp', or 'welcome_form')
 * @param filePath - Local filesystem URI of the image
 */
export const attachDocumentToJob = async (
  jobId: string,
  docType: 'visa_page' | 'entry_stamp' | 'welcome_form',
  filePath: string
): Promise<void> => {
  const attachUrl = `${BASE_URL}/jobs/${jobId}/attach/${docType}`;
  const normalizedUri = ensureFileUri(filePath);

  console.log(`[ApiService] Attaching ${docType} to job ${jobId}...`);

  const uploadResult = await FileSystem.uploadAsync(attachUrl, normalizedUri, {
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    fieldName: 'file',
    headers: {
      Accept: 'application/json',
    },
  });

  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    console.warn(
      `[ApiService] Failed attaching ${docType} (HTTP ${uploadResult.status}): ${uploadResult.body}`
    );
  } else {
    console.log(`[ApiService] Successfully attached ${docType} to job ${jobId}.`);
  }
};

/**
 * Submits all captured documents into the backend extraction pipeline.
 * Submits the mandatory passport bio page first, then sequentially attaches
 * the visa page, entry stamp, and handwritten Form-C arrival report.
 *
 * @param passportBioPath - Local file URI for passport bio page (mandatory)
 * @param visaPath - Local file URI for visa or OCI card (optional)
 * @param entryStampPath - Local file URI for immigration arrival stamp (optional)
 * @param formCPath - Local file URI for physical Form-C arrival report (optional)
 * @param reference - Optional guest reference identifier
 * @returns Parsed JobSubmitResponse containing the assigned job_id
 */
export const submitGuestDocuments = async (
  passportBioPath: string,
  visaPath?: string,
  entryStampPath?: string,
  formCPath?: string,
  reference?: string
): Promise<JobSubmitResponse> => {
  const submitUrl = `${BASE_URL}/jobs/submit`;

  if (!passportBioPath) {
    throw new Error('Passport bio page image is required for document extraction.');
  }

  const normalizedBioUri = ensureFileUri(passportBioPath);

  // 1. Submit primary passport bio page to create job record and receive job_id
  console.log('[ApiService] Submitting primary passport bio page to initialize job...');
  const submitResult = await FileSystem.uploadAsync(submitUrl, normalizedBioUri, {
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    fieldName: 'passport_bio',
    headers: {
      Accept: 'application/json',
    },
  });

  if (submitResult.status < 200 || submitResult.status >= 300) {
    throw new Error(
      `Job submission failed with status ${submitResult.status}: ${submitResult.body}`
    );
  }

  const parsedSubmit: JobSubmitResponse = JSON.parse(submitResult.body);
  const jobId = parsedSubmit.job_id;
  console.log(`[ApiService] Job initialized with ID: ${jobId}`);

  // 2. Attach Visa / OCI image if available
  if (visaPath && typeof visaPath === 'string' && visaPath.trim().length > 0) {
    try {
      await attachDocumentToJob(jobId, 'visa_page', visaPath);
    } catch (err) {
      console.warn('[ApiService] Error attaching visa page:', err);
    }
  }

  // 3. Attach Entry Stamp image if available
  if (entryStampPath && typeof entryStampPath === 'string' && entryStampPath.trim().length > 0) {
    try {
      await attachDocumentToJob(jobId, 'entry_stamp', entryStampPath);
    } catch (err) {
      console.warn('[ApiService] Error attaching entry stamp:', err);
    }
  }

  // 4. Attach Handwritten Form-C Arrival Report if available
  if (formCPath && typeof formCPath === 'string' && formCPath.trim().length > 0) {
    try {
      await attachDocumentToJob(jobId, 'welcome_form', formCPath);
    } catch (err) {
      console.warn('[ApiService] Error attaching welcome form:', err);
    }
  }

  return parsedSubmit;
};

/**
 * Polls the backend API for the current extraction status of a job.
 *
 * @param jobId - UUID returned by submitGuestDocuments
 * @returns JobStatusResponse containing status and extracted data
 */
export const pollJobStatus = async (jobId: string): Promise<JobStatusResponse> => {
  const statusUrl = `${BASE_URL}/jobs/${jobId}`;

  const response = await fetch(statusUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Polling failed for job ${jobId} with status ${response.status}: ${response.statusText}`
    );
  }

  const result: JobStatusResponse = await response.json();
  return result;
};