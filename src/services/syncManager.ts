/**
 * Background synchronization manager for HomestayMobileApp.
 * Handles uploading local document captures to the backend API,
 * polling asynchronous Form-C batch jobs, and persisting progressive
 * intermediate extraction results to local SQLite storage in real time.
 */

import {
  openDatabase,
  updateSubmissionStatus,
  SubmissionRecord,
  GuestDocumentRecord,
} from '../db/database';
import { submitGuestDocuments, pollJobStatus } from './apiService';

/**
 * Helper to safely extract the extraction payload dictionary
 * across various possible backend response wrappers.
 *
 * @param statusResponse - Raw JSON payload returned from the backend status endpoint.
 * @returns Parsed extraction dictionary or null.
 */
const extractDataPayload = (statusResponse: any): any => {
  if (!statusResponse || typeof statusResponse !== 'object') {
    return null;
  }
  const payload =
    statusResponse.extracted_data ||
    statusResponse.result ||
    statusResponse.data;

  // Return payload if present and non-empty
  if (payload && typeof payload === 'object' && Object.keys(payload).length > 0) {
    return payload;
  }
  return null;
};

/**
 * Polls an active extraction job with retry attempts until COMPLETED, FAILED, or timeout.
 * Runs in detached background execution so the user interface remains responsive.
 * Progressively persists partial extraction snapshots into SQLite while still PROCESSING,
 * allowing the Dashboard stage badges (Passport, Visa, Stamp, Form-C) to turn green in real time.
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
      await new Promise((resolve) => setTimeout(() => resolve(undefined), delayMs));

      console.log(`[SyncManager] Polling check ${attempt}/${maxAttempts} for job: ${jobId}`);
      const statusResponse = await pollJobStatus(jobId);

      const normalizedStatus = String(statusResponse.status || '').toUpperCase();

      // -----------------------------------------------------------------------
      // Progressive Intermediate Snapshot Persistence:
      // Check if backend returned partial extraction fields while still PROCESSING.
      // Write them to SQLite so Dashboard badges update to green progressively.
      // -----------------------------------------------------------------------
      const currentPayload = extractDataPayload(statusResponse);
      if (currentPayload) {
        try {
          const db = await openDatabase();
          const jsonString = JSON.stringify(currentPayload);

          // Persist current extraction state into SQLite guest_documents table
          await db.runAsync(
            `UPDATE guest_documents SET extracted_data_json = ? WHERE submission_id = ?;`,
            [jsonString, submissionId]
          );
          console.log(
            `[SyncManager] Persisted progressive snapshot (${Object.keys(currentPayload).length} keys) for submission: ${submissionId}`
          );
        } catch (dbErr) {
          console.warn(`[SyncManager] Failed writing progressive snapshot to SQLite:`, dbErr);
        }
      }

      // 2. Handle successful completion
      if (normalizedStatus === 'COMPLETED') {
        console.log(`[SyncManager] Job ${jobId} finished with status COMPLETED.`);

        // Final payload extraction
        const finalPayload = currentPayload || statusResponse;
        const jsonString = JSON.stringify(finalPayload);

        const db = await openDatabase();

        // Persist final completed JSON into SQLite guest_documents table
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
        // Reset or flag submission so operator can inspect or retry
        await updateSubmissionStatus(submissionId, 'UPLOAD_PENDING');
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
 * Also persists progressive intermediate results if available.
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
      const currentPayload = extractDataPayload(result);

      // Persist partial intermediate fields if present
      if (currentPayload) {
        const jsonPayload = JSON.stringify(currentPayload);
        await db.runAsync(
          `UPDATE guest_documents SET extracted_data_json = ? WHERE submission_id = ?;`,
          [jsonPayload, submission.id]
        );
      }

      // If fully finished, transition to PENDING_REVIEW
      if (normalizedStatus === 'COMPLETED') {
        const finalPayload = currentPayload || result;
        const jsonPayload = JSON.stringify(finalPayload);

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