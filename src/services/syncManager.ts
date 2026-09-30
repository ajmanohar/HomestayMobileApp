import { openDatabase, updateSubmissionStatus, SubmissionRecord, GuestDocumentRecord } from '../db/database';
import { submitGuestDocuments, pollJobStatus } from './apiService';

/**
 * Iterates through all submissions with status 'UPLOAD_PENDING' and uploads them
 * to the backend API via multipart/form-data.
 * Transitions state to 'PROCESSING' upon successful server ingestion.
 */
export const syncPendingUploads = async (): Promise<void> => {
  const db = await openDatabase();

  // 1. Fetch pending submissions
  const pendingSubmissions = await db.getAllAsync<SubmissionRecord>(
    `SELECT * FROM submissions WHERE status = 'UPLOAD_PENDING' ORDER BY created_at ASC;`
  );

  console.log(`[SyncManager] Found ${pendingSubmissions.length} pending submissions to upload.`);

  for (const submission of pendingSubmissions) {
    try {
      // 2. Fetch associated guest document paths
      const docs = await db.getAllAsync<GuestDocumentRecord>(
        `SELECT * FROM guest_documents WHERE submission_id = ? ORDER BY guest_index ASC LIMIT 1;`,
        [submission.id]
      );

      if (docs.length === 0) {
        console.warn(`[SyncManager] No documents found for submission ${submission.id}`);
        continue;
      }

      const guestDoc = docs[0];
      console.log(`[SyncManager] Uploading submission ${submission.id}...`);

      // 3. Post multipart payload to backend
      const response = await submitGuestDocuments(
        guestDoc.passport_bio_path,
        guestDoc.visa_stamp_path,
        guestDoc.entry_stamp_path,
        guestDoc.form_c_path,
        submission.reference
      );

      console.log(`[SyncManager] Upload succeeded. Job ID: ${response.job_id}`);

      // 4. Update local record to PROCESSING with assigned job_id
      await updateSubmissionStatus(submission.id, 'PROCESSING', response.job_id);
    } catch (error) {
      console.warn(`[SyncManager] Failed uploading submission ${submission.id}:`, error);
    }
  }
};

/**
 * Polls the backend API for all submissions currently in 'PROCESSING' state.
 * If status is 'COMPLETED', saves the extracted JSON and marks state as 'PENDING_REVIEW'.
 */
export const pollActiveJobs = async (): Promise<void> => {
  const db = await openDatabase();

  // 1. Query records currently undergoing OCR extraction
  const processingSubmissions = await db.getAllAsync<SubmissionRecord>(
    `SELECT * FROM submissions WHERE status = 'PROCESSING' AND job_id IS NOT NULL;`
  );

  console.log(`[SyncManager] Polling ${processingSubmissions.length} active processing jobs.`);

  for (const submission of processingSubmissions) {
    if (!submission.job_id) continue;

    try {
      console.log(`[SyncManager] Polling job status for ${submission.job_id}...`);
      // 2. Query status from backend
      const result: any = await pollJobStatus(submission.job_id);
      console.log(`[SyncManager] Server response for ${submission.job_id}:`, JSON.stringify(result));

      // Case-insensitive status check
      const normalizedStatus = String(result.status || '').toUpperCase();

      if (normalizedStatus === 'COMPLETED') {
        // Detect payload regardless of whether backend returns 'extracted_data', 'result', 'data', or top-level fields
        const dataPayload = result.extracted_data || result.result || result.data || result;
        const jsonPayload = JSON.stringify(dataPayload);

        // 3. Persist extracted JSON to guest_documents table
        await db.runAsync(
          `UPDATE guest_documents SET extracted_data_json = ? WHERE submission_id = ?;`,
          [jsonPayload, submission.id]
        );

        // 4. Advance submission state to PENDING_REVIEW
        console.log(`[SyncManager] Marking submission ${submission.id} as PENDING_REVIEW!`);
        await updateSubmissionStatus(submission.id, 'PENDING_REVIEW');
      }
    } catch (error) {
      console.warn(`[SyncManager] Polling check failed for job ${submission.job_id}:`, error);
    }
  }
};

/**
 * Unified sync runner: initiates pending uploads first, then polls active processing jobs.
 */
export const runFullSync = async (): Promise<void> => {
  await syncPendingUploads();
  await pollActiveJobs();
};