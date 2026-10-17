import {
  openDatabase,
  updateSubmissionStatus,
  SubmissionRecord,
  GuestDocumentRecord,
} from '../db/database';
import { submitGuestDocuments, pollJobStatus } from './apiService';

/**
 * Polls an active extraction job with retry attempts until COMPLETED, FAILED, or timeout.
 * Runs in detached background execution so the user interface remains responsive.
 *
 * @param submissionId - Local SQLite primary key for the submission
 * @param jobId - UUID assigned by the backend extraction pipeline
 * @param maxAttempts - Maximum polling iterations (default: 45)
 * @param delayMs - Interval between poll queries in milliseconds (default: 4000ms = 4s)
 */
export const pollJobUntilComplete = async (
  submissionId: string,
  jobId: string,
  maxAttempts: number = 45,
  delayMs: number = 4000
): Promise<void> => {
  console.log(`[SyncManager] Initializing background polling loop for job: ${jobId}`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // 1. Pause execution for the poll interval
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      console.log(`[SyncManager] Polling check ${attempt}/${maxAttempts} for job: ${jobId}`);
      const statusResponse = await pollJobStatus(jobId);

      const normalizedStatus = String(statusResponse.status || '').toUpperCase();

      // 2. Handle successful completion
      if (normalizedStatus === 'COMPLETED') {
        console.log(`[SyncManager] Job ${jobId} finished with status COMPLETED.`);

        // Locate data payload across possible backend response wrapper schemas
        const dataPayload =
          statusResponse.extracted_data ||
          statusResponse.result ||
          statusResponse.data ||
          statusResponse;

        const jsonString = JSON.stringify(dataPayload);

        const db = await openDatabase();

        // Persist extracted JSON into SQLite guest_documents table
        await db.runAsync(
          `UPDATE guest_documents SET extracted_data_json = ? WHERE submission_id = ?;`,
          [jsonString, submissionId]
        );

        // Transition submission status to PENDING_REVIEW
        await updateSubmissionStatus(submissionId, 'PENDING_REVIEW');
        console.log(`[SyncManager] Submission ${submissionId} successfully marked as PENDING_REVIEW!`);
        return;
      }

      // 3. Handle processing failure
      if (normalizedStatus === 'FAILED') {
        console.warn(`[SyncManager] Server flagged extraction failure for job: ${jobId}`);
        // Keep in PROCESSING or alert via local note so operator can inspect
        return;
      }
    } catch (error) {
      console.warn(`[SyncManager] Polling iteration ${attempt} encountered error:`, error);
    }
  }

  console.warn(`[SyncManager] Polling timeout exceeded for job: ${jobId}`);
};

/**
 * Iterates through all submissions with status 'UPLOAD_PENDING' and uploads them
 * to the backend API via multipart/form-data.
 * Transitions state to 'PROCESSING' upon successful server ingestion and
 * kicks off automatic polling.
 */
export const syncPendingUploads = async (): Promise<void> => {
  const db = await openDatabase();

  // 1. Fetch pending submissions from SQLite
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
      console.log(`[SyncManager] Uploading all capture artifacts for submission ${submission.id}...`);

      // 3. Dispatch multipart payload containing all 4 documents to backend API
      const response = await submitGuestDocuments(
        guestDoc.passport_bio_path,
        guestDoc.visa_stamp_path ?? undefined,
        guestDoc.entry_stamp_path ?? undefined,
        guestDoc.form_c_path ?? undefined,
        submission.reference
      );

      console.log(`[SyncManager] Upload succeeded. Server Job ID: ${response.job_id}`);

      // 4. Update local record to PROCESSING with assigned job_id
      await updateSubmissionStatus(submission.id, 'PROCESSING', response.job_id);

      // 5. Kick off automatic background polling loop without blocking the loop
      pollJobUntilComplete(submission.id, response.job_id).catch((err) =>
        console.warn(`[SyncManager] Background poll runner threw error for ${submission.id}:`, err)
      );
    } catch (error) {
      console.warn(`[SyncManager] Failed uploading submission ${submission.id}:`, error);
    }
  }
};

/**
 * Queries the backend API for all submissions currently in 'PROCESSING' state.
 * Used during manual pull-to-refresh on the Dashboard.
 */
export const pollActiveJobs = async (): Promise<void> => {
  const db = await openDatabase();

  // 1. Query records currently undergoing OCR extraction
  const processingSubmissions = await db.getAllAsync<SubmissionRecord>(
    `SELECT * FROM submissions WHERE status = 'PROCESSING' AND job_id IS NOT NULL;`
  );

  console.log(`[SyncManager] Manual poll triggered for ${processingSubmissions.length} active jobs.`);

  for (const submission of processingSubmissions) {
    if (!submission.job_id) continue;

    try {
      console.log(`[SyncManager] Polling server for job ${submission.job_id}...`);
      const result = await pollJobStatus(submission.job_id);

      const normalizedStatus = String(result.status || '').toUpperCase();

      if (normalizedStatus === 'COMPLETED') {
        const dataPayload =
          result.extracted_data ||
          result.result ||
          result.data ||
          result;

        const jsonPayload = JSON.stringify(dataPayload);

        // Persist extracted JSON to guest_documents table
        await db.runAsync(
          `UPDATE guest_documents SET extracted_data_json = ? WHERE submission_id = ?;`,
          [jsonPayload, submission.id]
        );

        // Advance submission state to PENDING_REVIEW
        console.log(`[SyncManager] Marking submission ${submission.id} as PENDING_REVIEW!`);
        await updateSubmissionStatus(submission.id, 'PENDING_REVIEW');
      }
    } catch (error) {
      console.warn(`[SyncManager] Manual polling check failed for job ${submission.job_id}:`, error);
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