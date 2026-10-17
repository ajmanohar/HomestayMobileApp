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
 * Helper to construct an uploadable file object for React Native FormData.
 *
 * @param uri - Local file URI (e.g., file:///data/user/0/.../passport.jpg)
 * @param defaultName - Fallback file name if URI does not contain one
 * @param type - MIME type string
 */
const createFormDataFile = (uri: string, defaultName: string, type: string = 'image/jpeg') => {
  const filename = uri.split('/').pop() || defaultName;
  return {
    uri,
    name: filename,
    type,
  } as any;
};

/**
 * Submits all captured document images to the backend extraction pipeline via multipart/form-data.
 * Packages passport_bio, visa, entry_stamp, and form_c into a single multi-part form payload.
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

  // Initialize multipart/form-data container
  const formData = new FormData();

  // 1. Mandatory: Passport Bio-Data page
  if (passportBioPath) {
    formData.append(
      'passport_bio',
      createFormDataFile(passportBioPath, 'passport_bio.jpg', 'image/jpeg')
    );
  } else {
    throw new Error('Passport bio page is required for document extraction.');
  }

  // 2. Optional: Visa / OCI page
  if (visaPath) {
    formData.append(
      'visa',
      createFormDataFile(visaPath, 'visa.jpg', 'image/jpeg')
    );
  }

  // 3. Optional: Entry Immigration Stamp page
  if (entryStampPath) {
    formData.append(
      'entry_stamp',
      createFormDataFile(entryStampPath, 'entry_stamp.jpg', 'image/jpeg')
    );
  }

  // 4. Optional: Handwritten Form-C arrival slip
  if (formCPath) {
    formData.append(
      'form_c',
      createFormDataFile(formCPath, 'form_c.jpg', 'image/jpeg')
    );
  }

  // 5. Booking reference metadata
  if (reference && reference.trim().length > 0) {
    formData.append('reference', reference.trim());
  }

  // Post the multipart payload to the backend FastAPI endpoint
  const response = await fetch(uploadUrl, {
    method: 'POST',
    body: formData,
    headers: {
      Accept: 'application/json',
      // Note: Do NOT set 'Content-Type': 'multipart/form-data' manually here;
      // React Native fetch will automatically append the correct multipart boundary.
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Job submission failed with status ${response.status}: ${errorText}`
    );
  }

  // Parse and return server JSON response
  const parsedResponse: JobSubmitResponse = await response.json();
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