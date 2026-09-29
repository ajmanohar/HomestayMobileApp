import * as SQLite from 'expo-sqlite';

/**
 * Valid lifecycle states for a guest document submission.
 * - UPLOAD_PENDING: Photos taken and saved locally; ready to be posted.
 * - PROCESSING: Upload completed; API returned job_id; server running OCR extraction.
 * - PENDING_REVIEW: Extraction completed; JSON payload ready for operator verification.
 * - REVIEWED: Operator inspected and validated/edited fields.
 */
export type SubmissionStatus = 
  | 'UPLOAD_PENDING' 
  | 'PROCESSING' 
  | 'PENDING_REVIEW' 
  | 'REVIEWED';

/**
 * Representation of a Submission record stored in the local SQLite database.
 */
export interface SubmissionRecord {
  id: string; // Client-side generated UUID
  reference?: string; // Optional booking ID or lead guest name
  guest_count: number;
  status: SubmissionStatus;
  job_id?: string; // Server tracking UUID returned by /api/v1/jobs/submit
  created_at: string;
  updated_at: string;
}

/**
 * Representation of the 4 document image paths and extracted values for an individual guest.
 */
export interface GuestDocumentRecord {
  id: string; // UUID for this document set
  submission_id: string; // Foreign key referencing submissions.id
  guest_index: number;
  passport_bio_path: string; // Local file URI for passport bio-data page
  visa_stamp_path?: string; // Local file URI for visa or OCI card
  entry_stamp_path?: string; // Local file URI for arrival stamp
  form_c_path?: string; // Local file URI for physical Form-C arrival sheet
  extracted_data_json?: string; // Serialized JSON payload returned from the backend OCR
}

/**
 * Opens or initializes the local SQLite database file asynchronously.
 */
export const openDatabase = async (): Promise<SQLite.SQLiteDatabase> => {
  return await SQLite.openDatabaseAsync('homestay_documents.db');
};

/**
 * Initializes required relational tables if they do not already exist.
 * Should be called once when the application boots.
 */
export const initDatabase = async (): Promise<void> => {
  const db = await openDatabase();

  // Execute schema creation scripts
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY NOT NULL,
      reference TEXT,
      guest_count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      job_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS guest_documents (
      id TEXT PRIMARY KEY NOT NULL,
      submission_id TEXT NOT NULL,
      guest_index INTEGER NOT NULL DEFAULT 0,
      passport_bio_path TEXT NOT NULL,
      visa_stamp_path TEXT,
      entry_stamp_path TEXT,
      form_c_path TEXT,
      extracted_data_json TEXT,
      FOREIGN KEY (submission_id) REFERENCES submissions (id) ON DELETE CASCADE
    );
  `);
};