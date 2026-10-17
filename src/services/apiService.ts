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
  extracted_data?: Record<string, any>;
  result?: Record<string, any>;
  data?: Record<string, any>;
  error?: string;
}

/**
 * Normalizes file URI to ensure valid file:// prefix for native file system handlers.
 *
 * @param uri - Local file URI or path
 * @returns Fully qualified file:// URI string
 */
const ensureFileUri = (uri: string): string => {
  if (uri.startsWith('file://')) {
    return uri;
  }
  return `file://${uri}`;
};

/**
 * Submits the captured passport document to the backend extraction pipeline.
 * Uses Expo FileSystem native uploadAsync to bypass React Native's Android
 * OkHttp FormDataPart bridge restrictions.
 *
 * @param passportBioPath - Local file URI for passport bio page (mandatory)
 * @param visaPath - Local file URI for visa or OCI card (optional)
 * @param entryStampPath - Local file URI for entry immigration stamp (optional)
 * @param formCPath - Local file URI for handwritten Form-C arrival report (optional)
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

  if (!passportBioPath) {
    throw new Error('Passport bio page image is required for document extraction.');
  }

  const normalizedBioUri = ensureFileUri(passportBioPath);

  // Prepare metadata parameters passed alongside the binary
  const parameters: Record<string, string> = {
    reference: reference ?? '',
  };

  if (visaPath) {
    parameters['has_visa'] = 'true';
  }
  if (entryStampPath) {
    parameters['has_entry_stamp'] = 'true';
  }
  if (formCPath) {
    parameters['has_form_c'] = 'true';
  }

  // Execute native background multipart upload via Expo FileSystem legacy engine
  const uploadResult = await FileSystem.uploadAsync(uploadUrl, normalizedBioUri, {
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    fieldName: 'passport_bio',
    parameters: parameters,
    headers: {
      Accept: 'application/json',
    },
  });

  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    throw new Error(
      `Job submission failed with status ${uploadResult.status}: ${uploadResult.body}`
    );
  }

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