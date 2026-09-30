import * as SQLite from 'expo-sqlite';

/**
 * Valid lifecycle states for a guest document submission:
 * - UPLOAD_PENDING: Documents saved locally, awaiting multipart upload
 * - PROCESSING: Upload completed; API returned job_id; server extraction running
 * - PENDING_REVIEW: Server extraction completed; awaiting operator verification
 * - REVIEWED: Operator validated and finalized values
 */
export type SubmissionStatus = 
  | 'UPLOAD_PENDING' 
  | 'PROCESSING' 
  | 'PENDING_REVIEW' 
  | 'REVIEWED';

/**
 * Represents a Submission row in the local SQLite table.
 */
export interface SubmissionRecord {
  id: string;              // Client-generated UUID string
  reference?: string;      // Booking ID or guest name
  guest_count: number;     // Number of guests under this submission
  status: SubmissionStatus;// FSM tracking state
  job_id?: string;         // Backend job tracking UUID
  created_at: string;      // ISO timestamp
  updated_at: string;      // ISO timestamp
}

/**
 * Represents the 4 captured document image URIs and OCR output for an individual guest.
 */
export interface GuestDocumentRecord {
  id: string;                  // Primary key
  submission_id: string;       // Foreign key referencing submissions.id
  guest_index: number;         // 0-indexed position within submission
  passport_bio_path: string;   // Local file URI for passport bio-data page
  visa_stamp_path?: string;    // Local file URI for visa or OCI card
  entry_stamp_path?: string;   // Local file URI for immigration arrival stamp
  form_c_path?: string;        // Local file URI for handwritten Form-C sheet
  extracted_data_json?: string;// Serialized JSON payload returned from OCR backend
}

// Cached single instance of the database connection
let dbInstance: SQLite.SQLiteDatabase | null = null;

/**
 * Opens or accesses the persistent SQLite database instance.
 */
export const openDatabase = async (): Promise<SQLite.SQLiteDatabase> => {
  if (!dbInstance) {
    dbInstance = await SQLite.openDatabaseAsync('homestay_documents.db');
  }
  return dbInstance;
};

/**
 * Initializes required tables safely by executing individual DDL statements.
 * Omits WAL pragma inside execAsync to prevent Expo Go Android NullPointerExceptions.
 */
export const initDatabase = async (): Promise<void> => {
  const db = await openDatabase();

  // 1. Create parent submissions table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY NOT NULL,
      reference TEXT,
      guest_count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      job_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // 2. Create child guest_documents table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS guest_documents (
      id TEXT PRIMARY KEY NOT NULL,
      submission_id TEXT NOT NULL,
      guest_index INTEGER NOT NULL DEFAULT 0,
      passport_bio_path TEXT NOT NULL,
      visa_stamp_path TEXT,
      entry_stamp_path TEXT,
      form_c_path TEXT,
      extracted_data_json TEXT
    );
  `);

  console.log('[SQLite] Local database initialized successfully.');
};

/**
 * Inserts a new submission along with its captured guest documents in a single atomic transaction.
 *
 * @param submission - The root submission record
 * @param documents - Array of document records corresponding to each guest
 */
export const insertSubmission = async (
  submission: SubmissionRecord,
  documents: GuestDocumentRecord[]
): Promise<void> => {
  const db = await openDatabase();

  await db.withTransactionAsync(async () => {
    // 1. Insert parent submission record (strictly converting all undefined fields to null)
    await db.runAsync(
      `INSERT INTO submissions (id, reference, guest_count, status, job_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [
        String(submission.id),
        submission.reference ? String(submission.reference) : null,
        Number(submission.guest_count) || 1,
        String(submission.status),
        submission.job_id ? String(submission.job_id) : null,
        String(submission.created_at),
        String(submission.updated_at),
      ]
    );

    // 2. Insert associated guest document paths
    for (const doc of documents) {
      await db.runAsync(
        `INSERT INTO guest_documents (
          id, submission_id, guest_index, passport_bio_path, visa_stamp_path, entry_stamp_path, form_c_path, extracted_data_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          String(doc.id),
          String(doc.submission_id),
          Number(doc.guest_index) || 0,
          String(doc.passport_bio_path),
          doc.visa_stamp_path ? String(doc.visa_stamp_path) : null,
          doc.entry_stamp_path ? String(doc.entry_stamp_path) : null,
          doc.form_c_path ? String(doc.form_c_path) : null,
          doc.extracted_data_json ? String(doc.extracted_data_json) : null,
        ]
      );
    }
  });
};

/**
 * Updates the tracking status and optional backend job_id of an existing submission.
 *
 * @param id - UUID of the target submission
 * @param status - Updated state (e.g. 'PROCESSING', 'PENDING_REVIEW', 'REVIEWED')
 * @param jobId - Optional backend job tracking UUID
 */
export const updateSubmissionStatus = async (
  id: string,
  status: SubmissionStatus,
  jobId?: string
): Promise<void> => {
  const db = await openDatabase();
  const now = new Date().toISOString();
  const safeId = String(id);
  const safeStatus = String(status);

  if (jobId !== undefined && jobId !== null) {
    await db.runAsync(
      `UPDATE submissions SET status = ?, job_id = ?, updated_at = ? WHERE id = ?;`,
      [safeStatus, String(jobId), now, safeId]
    );
  } else {
    await db.runAsync(
      `UPDATE submissions SET status = ?, updated_at = ? WHERE id = ?;`,
      [safeStatus, now, safeId]
    );
  }
};

/**
 * Retrieves all submissions ordered chronologically (newest first).
 */
export const getAllSubmissions = async (): Promise<SubmissionRecord[]> => {
  const db = await openDatabase();
  const rows = await db.getAllAsync<SubmissionRecord>(
    `SELECT * FROM submissions ORDER BY created_at DESC;`
  );
  return rows || [];
};