// ==============================================================================
// database.ts - HomestayMobileApp (React Native / Expo SQLite)
// ==============================================================================
// Local SQLite persistence layer for guest submissions and document captures.
// Manages local offline queue, multi-guest image manifests, extracted Form-C
// data snapshots, and mobile-triggered cascading deletion (Task 44).
//
// Dual-Visa & Isolated Documents:
// - Stores both visa_document_path (e-Visa paper/PDF) and visa_stamp_path (passport stamp).
// - Stores extracted_data_json containing the server's per-document container.
// ==============================================================================

import * as SQLite from 'expo-sqlite';
import { deleteJob } from '../services/apiService';

// Database name identifier
const DATABASE_NAME = 'homestay_formc.db';

// ------------------------------------------------------------------------------
// Data Type Definitions
// ------------------------------------------------------------------------------

export type SubmissionStatus =
  | 'UPLOAD_PENDING'
  | 'PROCESSING'
  | 'PENDING_REVIEW'
  | 'SUBMITTED'
  | 'REVIEWED'
  | 'FAILED';

export interface SubmissionRecord {
  id: string;
  reference: string | null;
  guest_count: number;
  status: SubmissionStatus;
  job_id?: string | null;
  created_at: string;
  updated_at?: string;
}

export interface GuestDocumentRecord {
  id: string;
  submission_id: string;
  guest_index: number;
  passport_bio_path: string;
  visa_document_path?: string | null; // e-Visa Paper / PDF printout (Task 42)
  visa_stamp_path?: string | null;    // Consular visa stamp in passport booklet (Task 42)
  entry_stamp_path?: string | null;
  form_c_path?: string | null;
  guest_photo_path?: string | null;
  extracted_data_json?: string | null;
  created_at?: string;
}

// ------------------------------------------------------------------------------
// Database Connection Singleton
// ------------------------------------------------------------------------------

let dbInstance: SQLite.SQLiteDatabase | null = null;

/**
 * Returns an asynchronous connection handle to the local SQLite database.
 */
export const openDatabase = async (): Promise<SQLite.SQLiteDatabase> => {
  if (!dbInstance) {
    dbInstance = await SQLite.openDatabaseAsync(DATABASE_NAME);
  }
  return dbInstance;
};

/**
 * Initializes tables and executes defensive schema migrations.
 * Called once during application startup in App.tsx.
 */
export const initDatabase = async (): Promise<void> => {
  const db = await openDatabase();

  // 1. Create parent submissions table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY NOT NULL,
      reference TEXT,
      guest_count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'UPLOAD_PENDING',
      job_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 2. Create child guest_documents table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS guest_documents (
      id TEXT PRIMARY KEY NOT NULL,
      submission_id TEXT NOT NULL,
      guest_index INTEGER NOT NULL DEFAULT 0,
      passport_bio_path TEXT NOT NULL,
      visa_document_path TEXT,
      visa_stamp_path TEXT,
      entry_stamp_path TEXT,
      form_c_path TEXT,
      guest_photo_path TEXT,
      extracted_data_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
    );
  `);

  // 3. Defensive migration: ensure visa_document_path exists in existing installs
  try {
    await db.execAsync(`
      ALTER TABLE guest_documents ADD COLUMN visa_document_path TEXT;
    `);
  } catch {
    // Column already exists; continue safely
  }

  // 4. Create indexes to optimize dashboard and carousel queries
  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
    CREATE INDEX IF NOT EXISTS idx_guest_docs_sub ON guest_documents(submission_id);
  `);
};

// ------------------------------------------------------------------------------
// Submission CRUD Functions
// ------------------------------------------------------------------------------

/**
 * Inserts a newly initiated guest submission.
 */
export const createSubmission = async (
  id: string,
  reference: string | null = null,
  guestCount: number = 1
): Promise<SubmissionRecord> => {
  const db = await openDatabase();
  const createdAt = new Date().toISOString();

  await db.runAsync(
    `INSERT INTO submissions (id, reference, guest_count, status, created_at)
     VALUES (?, ?, ?, 'UPLOAD_PENDING', ?);`,
    [id, reference, guestCount, createdAt]
  );

  return {
    id,
    reference,
    guest_count: guestCount,
    status: 'UPLOAD_PENDING',
    job_id: null,
    created_at: createdAt,
  };
};

/**
 * Persists local image paths captured for a guest in a submission.
 */
export const saveGuestDocuments = async (
  doc: GuestDocumentRecord
): Promise<void> => {
  const db = await openDatabase();
  const createdAt = doc.created_at || new Date().toISOString();

  await db.runAsync(
    `INSERT INTO guest_documents (
       id, submission_id, guest_index, passport_bio_path,
       visa_document_path, visa_stamp_path, entry_stamp_path,
       form_c_path, guest_photo_path, extracted_data_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      doc.id,
      doc.submission_id,
      doc.guest_index,
      doc.passport_bio_path,
      doc.visa_document_path ?? null,
      doc.visa_stamp_path ?? null,
      doc.entry_stamp_path ?? null,
      doc.form_c_path ?? null,
      doc.guest_photo_path ?? null,
      doc.extracted_data_json ?? null,
      createdAt,
    ]
  );
};

/**
 * Convenience batch helper used by CaptureScreen to persist both
 * submission metadata and all guest document child rows in one call.
 */
export const insertSubmission = async (
  submission: SubmissionRecord,
  docs: GuestDocumentRecord[]
): Promise<void> => {
  const db = await openDatabase();
  const createdAt = submission.created_at || new Date().toISOString();

  await db.runAsync(
    `INSERT INTO submissions (id, reference, guest_count, status, job_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?);`,
    [
      submission.id,
      submission.reference ?? null,
      submission.guest_count,
      submission.status,
      submission.job_id ?? null,
      createdAt,
    ]
  );

  for (const doc of docs) {
    await saveGuestDocuments({
      ...doc,
      created_at: doc.created_at || createdAt,
    });
  }
};

/**
 * Retrieves all submissions ordered descending by creation date.
 */
export const getAllSubmissions = async (): Promise<SubmissionRecord[]> => {
  const db = await openDatabase();
  const rows = await db.getAllAsync<SubmissionRecord>(
    `SELECT * FROM submissions ORDER BY created_at DESC;`
  );
  return rows ?? [];
};

/**
 * Retrieves a single submission record by UUID.
 */
export const getSubmissionById = async (id: string): Promise<SubmissionRecord | null> => {
  const db = await openDatabase();
  const row = await db.getFirstAsync<SubmissionRecord>(
    `SELECT * FROM submissions WHERE id = ?;`,
    [id]
  );
  return row ?? null;
};

/**
 * Updates the lifecycle execution state of a submission.
 * Accepts optional jobId to bind server-assigned job ID simultaneously.
 */
export const updateSubmissionStatus = async (
  id: string,
  newStatus: SubmissionStatus,
  jobId?: string | null
): Promise<void> => {
  const db = await openDatabase();
  if (jobId) {
    await db.runAsync(
      `UPDATE submissions SET status = ?, job_id = ? WHERE id = ?;`,
      [newStatus, jobId, id]
    );
  } else {
    await db.runAsync(
      `UPDATE submissions SET status = ? WHERE id = ?;`,
      [newStatus, id]
    );
  }
};

/**
 * Binds the remote Dell server job UUID to a local submission record.
 */
export const updateSubmissionJobId = async (
  id: string,
  jobId: string
): Promise<void> => {
  const db = await openDatabase();
  await db.runAsync(
    `UPDATE submissions SET job_id = ? WHERE id = ?;`,
    [jobId, id]
  );
};

/**
 * Progressively stores the server's extracted JSON payload into guest_documents.
 */
export const updateGuestExtractedData = async (
  submissionId: string,
  extractedJson: string
): Promise<void> => {
  const db = await openDatabase();
  await db.runAsync(
    `UPDATE guest_documents SET extracted_data_json = ? WHERE submission_id = ?;`,
    [extractedJson, submissionId]
  );
};

// ------------------------------------------------------------------------------
// Task 44: Mobile-Triggered Cascading Deletion
// ------------------------------------------------------------------------------

/**
 * Permanently deletes a submission locally from SQLite and cascades the deletion
 * to the remote Dell edge server to remove the job record and stored images.
 *
 * @param submissionId - The local submission UUID.
 */
export const deleteSubmissionLocallyAndRemote = async (submissionId: string): Promise<void> => {
  const db = await openDatabase();

  // 1. Fetch current job_id before deleting locally
  const submission = await getSubmissionById(submissionId);
  const remoteJobId = submission?.job_id;

  // 2. Cascade purge to remote Dell edge server if job_id is present
  if (remoteJobId) {
    try {
      console.log(`[Database] Cascading deletion to remote server for job: ${remoteJobId}`);
      await deleteJob(remoteJobId);
      console.log(`[Database] Remote server job ${remoteJobId} successfully purged.`);
    } catch (remoteErr) {
      console.warn(`[Database] Remote purge notice for job ${remoteJobId}:`, remoteErr);
    }
  }

  // 3. Purge child guest document records from local SQLite
  await db.runAsync(
    `DELETE FROM guest_documents WHERE submission_id = ?;`,
    [submissionId]
  );

  // 4. Purge parent submission record from local SQLite
  await db.runAsync(
    `DELETE FROM submissions WHERE id = ?;`,
    [submissionId]
  );

  console.log(`[Database] Submission ${submissionId} purged from local SQLite.`);
};