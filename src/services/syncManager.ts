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

  for (const submission of pendingSubmissions) {
    try {
      // 2. Fetch associated guest document paths
      const docs = await db.getAllAsync<GuestDocumentRecord>(
        `SELECT * FROM guest_documents WHERE submission_id = ? ORDER BY guest_index ASC LIMIT 1;`,
        [submission.id]
      );

      if (docs.length === 0) {
        continue;
      }

      const guestDoc = docs[0];

      // 3. Post multipart payload to backend
      const response = await submitGuestDocuments(
        guestDoc.passport_bio_path,
        guestDoc.visa_stamp_path,
        guestDoc.entry_stamp_path,
        guestDoc.form_c_path,
        submission.reference
      );

      // 4. Update local record to PROCESSING with assigned job_id
      await updateSubmissionStatus(submission.id, 'PROCESSING', response.job_id);
    } catch (error) {
      // Keep state as UPLOAD_PENDING so it retries on next sync cycle
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

  for (const submission of processingSubmissions) {
    if (!submission.job_id) continue;

    try {
      // 2. Query status from backend
      const result = await pollJobStatus(submission.job_id);

      if (result.status === 'COMPLETED' && result.extracted_data) {
        const jsonPayload = JSON.stringify(result.extracted_data);

        // 3. Persist extracted JSON to guest_documents table
        await db.runAsync(
          `UPDATE guest_documents SET extracted_data_json = ? WHERE submission_id = ?;`,
          [jsonPayload, submission.id]
        );

        // 4. Advance submission state to PENDING_REVIEW
        await updateSubmissionStatus(submission.id, 'PENDING_REVIEW');
      }
    } catch (error) {
      console.warn(`[SyncManager] Polling check failed for job ${submission.job_id}:`, error);
    }
  }
};

/**
 * Unified sync runner: initiates pending uploads first, then polls active processing jobs.
 * Intended for pull-to-refresh gestures and screen focus triggers.
 */
export const runFullSync = async (): Promise<void> => {
  await syncPendingUploads();
  await pollActiveJobs();
};