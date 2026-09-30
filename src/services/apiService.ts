import * as FileSystem from 'expo-file-system';

/**
 * Production backend API endpoint served through Cloudflare Tunnel.
 */
const BASE_URL = 'https://api.theasymptotebrief.com/api/v1';

/**
 * Expected response when initiating a job at /jobs/submit.
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
  extracted_data?: Record<string, any>;
  error?: string;
}

/**
 * Submits the 4 captured document images to the backend extraction pipeline via multipart/form-data.
 * Uses expo-file-system uploadAsync to prevent locking the UI thread during image transfer.
 *
 * @param passportBioPath - Local file URI for passport bio page
 * @param visaPath - Local file URI for visa or OCI card
 * @param entryStampPath - Local file URI for entry immigration stamp
 * @param formCPath - Local file URI for handwritten Form-C arrival report
 * @param reference - Optional booking reference or guest identifier
 * @returns Parsed JobSubmitResponse containing the assigned job_id
 */
export const submitGuestDocuments = async (
  passportBioPath: string,
  visaPath?: string,
  entryStampPath?: string,
  formCPath?: string,
  reference?: string
): Promise<JobSubmitResponse> => {
  const uploadUrl = `${BASE_URL}/jobs/submit`;

  // Construct multipart upload request
  // Note: uploadAsync natively streams files on the background native thread
  const uploadResult = await FileSystem.uploadAsync(uploadUrl, passportBioPath, {
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    fieldName: 'passport_bio',
    parameters: {
      reference: reference ?? '',
    },
    headers: {
      Accept: 'application/json',
    },
  });

  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    throw new Error(
      `Job submission failed with status ${uploadResult.status}: ${uploadResult.body}`
    );
  }

  // Parse and return server JSON response
  const parsedResponse: JobSubmitResponse = JSON.parse(uploadResult.body);
  return parsedResponse;
};

/**
 * Polls the backend API for the current extraction status of a queued or processing job.
 *
 * @param jobId - UUID returned by submitGuestDocuments
 * @returns JobStatusResponse containing status flag and optional extracted OCR data
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