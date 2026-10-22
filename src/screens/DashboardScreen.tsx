// ==============================================================================
// DashboardScreen.tsx - HomestayMobileApp (React Native / Expo SDK 57)
// ==============================================================================
// Main guest submissions dashboard displaying real-time extraction progress,
// per-document stage badges, re-submission controls, and cascading deletion.
//
// Lifecycle Constraints (Task 43):
// - Portal auto-submission is removed from mobile.
// - Mobile lifecycle ends at Review & Re-submit.
//
// Features:
// - Task 42: Dynamic stage pills for Dual Visa (Visa Document vs. Visa Stamp).
// - Task 44: Mobile-Triggered Deletion with cascade purge to Dell edge server.
// - Task 45: Reads isolated per-document status containers with fallback.
// ==============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  Alert,
  Modal,
  TextInput,
} from 'react-native';
import { useAppTheme } from '../theme/ThemeContext';
import {
  getAllSubmissions,
  openDatabase,
  updateSubmissionStatus,
  deleteSubmissionLocallyAndRemote,
  SubmissionRecord,
  GuestDocumentRecord,
  SubmissionStatus,
} from '../db/database';
import { runFullSync, pollJobUntilComplete } from '../services/syncManager';
import { submitPassportBio, attachDocumentToJob, startJobProcessing } from '../services/apiService';
import {
  getPortalCredentials,
  savePortalCredentials,
  clearPortalCredentials,
} from '../services/credentialService';

interface DashboardScreenProps {
  onStartNewCapture: () => void;
  onOpenReview: (submissionId: string) => void;
}

/**
 * Aggregated submission structure including loaded guest document child records.
 */
interface SubmissionWithGuests extends SubmissionRecord {
  guests: GuestDocumentRecord[];
}

/**
 * Stage status evaluation helper for an individual document.
 */
type StageStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'NOT_ATTACHED';

export const DashboardScreen: React.FC<DashboardScreenProps> = ({
  onStartNewCapture,
  onOpenReview,
}) => {
  // Theme styling tokens (supports dynamic light / dark mode toggle)
  const { colors, isDark, toggleTheme } = useAppTheme();

  // Screen queue and processing states
  const [submissions, setSubmissions] = useState<SubmissionWithGuests[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Portal credentials modal state
  const [isCredsModalVisible, setIsCredsModalVisible] = useState<boolean>(false);
  const [portalUserId, setPortalUserId] = useState<string>('');
  const [portalPassword, setPortalPassword] = useState<string>('');
  const [isSavingCreds, setIsSavingCreds] = useState<boolean>(false);

  /**
   * Queries local SQLite database to load recent guest submissions
   * and attaches all guest document child rows per submission.
   */
  const loadSubmissions = useCallback(async () => {
    try {
      const rawRecords = await getAllSubmissions();
      const records = Array.isArray(rawRecords) ? rawRecords : [];
      const db = await openDatabase();

      const loadedSubmissions: SubmissionWithGuests[] = await Promise.all(
        records.map(async (sub) => {
          try {
            const guestDocs = await db.getAllAsync<GuestDocumentRecord>(
              'SELECT * FROM guest_documents WHERE submission_id = ? ORDER BY guest_index ASC;',
              [sub.id]
            );
            return {
              ...sub,
              guests: Array.isArray(guestDocs) ? guestDocs : [],
            };
          } catch (err) {
            console.warn(`[Dashboard] Failed loading guests for submission ${sub.id}:`, err);
            return {
              ...sub,
              guests: [],
            };
          }
        })
      );

      setSubmissions(loadedSubmissions);
    } catch (error) {
      console.warn('[Dashboard] Error querying submissions from SQLite:', error);
      setSubmissions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSubmissions();
  }, [loadSubmissions]);

  /**
   * Pull-to-refresh handler: runs sync runner against backend API,
   * then reloads local database rows.
   */
  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      console.log('[Dashboard] Manual pull-to-refresh triggered.');
      await runFullSync();
      await loadSubmissions();
    } catch (error: any) {
      console.warn('[Dashboard] Pull-to-refresh error:', error);
      Alert.alert('Sync Notice', error.message || 'Unable to sync with remote server.');
    } finally {
      setRefreshing(false);
    }
  };

  /**
   * Opens the credentials modal and pre-loads stored values from SecureStore.
   */
  const handleOpenCredentialsModal = async () => {
    try {
      const creds = await getPortalCredentials();
      setPortalUserId(creds.userId || '');
      setPortalPassword(creds.password || '');
      setIsCredsModalVisible(true);
    } catch (error) {
      console.warn('[Dashboard] Error fetching stored credentials:', error);
      setIsCredsModalVisible(true);
    }
  };

  /**
   * Saves updated portal credentials into Android Keystore / EncryptedSharedPreferences.
   */
  const handleSaveCredentials = async () => {
    if (!portalUserId.trim() || !portalPassword.trim()) {
      Alert.alert('Validation Error', 'Both User ID and Password are required.');
      return;
    }

    try {
      setIsSavingCreds(true);
      await savePortalCredentials(portalUserId, portalPassword);
      setIsSavingCreds(false);
      setIsCredsModalVisible(false);
      Alert.alert('Saved', 'Form-C portal credentials securely saved on device.');
    } catch (error: any) {
      setIsSavingCreds(false);
      Alert.alert('Save Error', error.message || 'Failed to save credentials.');
    }
  };

  /**
   * Clears saved portal credentials from secure storage.
   */
  const handleClearCredentials = async () => {
    try {
      await clearPortalCredentials();
      setPortalUserId('');
      setPortalPassword('');
      Alert.alert('Cleared', 'Portal credentials removed from secure storage.');
    } catch (error: any) {
      Alert.alert('Clear Error', error.message || 'Failed to clear credentials.');
    }
  };

  /**
   * Resubmits an entire submission for background AI extraction without re-capturing images.
   * Dispatches passport bio first, attaches optional documents, and triggers worker start.
   */
  const handleTriggerReExtract = async (item: SubmissionWithGuests) => {
    if (!item || !item.id) {
      Alert.alert('Error', 'Invalid submission record ID.');
      return;
    }

    try {
      setRetryingId(item.id);
      const guestList = Array.isArray(item.guests) ? item.guests : [];

      if (guestList.length === 0) {
        Alert.alert('Error', 'No guest document records found for this submission.');
        return;
      }

      const guestDoc = guestList[0];
      if (!guestDoc.passport_bio_path) {
        Alert.alert('Error', 'Passport bio image path is missing.');
        return;
      }

      // 1. Submit passport bio to initialize new job
      const submitRes = await submitPassportBio(guestDoc.passport_bio_path);
      const newJobId = submitRes.job_id;

      // 2. Attach optional secondary captures
      if (guestDoc.visa_document_path) {
        await attachDocumentToJob(newJobId, 'visa_document', guestDoc.visa_document_path);
      }
      if (guestDoc.visa_stamp_path) {
        await attachDocumentToJob(newJobId, 'visa_stamp', guestDoc.visa_stamp_path);
      }
      if (guestDoc.entry_stamp_path) {
        await attachDocumentToJob(newJobId, 'entry_stamp', guestDoc.entry_stamp_path);
      }
      if (guestDoc.form_c_path) {
        await attachDocumentToJob(newJobId, 'welcome_form', guestDoc.form_c_path);
      }
      if (guestDoc.guest_photo_path) {
        await attachDocumentToJob(newJobId, 'guest_photo', guestDoc.guest_photo_path);
      }

      // 3. Trigger worker
      await startJobProcessing(newJobId);

      // 4. Update local SQLite database
      const db = await openDatabase();
      await db.runAsync('UPDATE submissions SET status = ?, job_id = ? WHERE id = ?;', [
        'PROCESSING',
        newJobId,
        item.id,
      ]);
      await db.runAsync('UPDATE guest_documents SET extracted_data_json = NULL WHERE submission_id = ?;', [
        item.id,
      ]);

      // 5. Kick off background polling
      pollJobUntilComplete(item.id, newJobId).catch((pollErr) =>
        console.warn(`[Dashboard] Polling loop error for ${item.id}:`, pollErr)
      );

      await loadSubmissions();
    } catch (err: any) {
      Alert.alert('Re-submission Failed', err.message || 'Unable to re-submit documents.');
    } finally {
      setRetryingId(null);
    }
  };

  /**
   * Permanently deletes a submission locally and cascades purge to the Dell server (Task 44).
   */
  const handleDeleteSubmission = (submissionId: string) => {
    Alert.alert(
      'Delete Submission',
      'Permanently delete this submission and all associated document images from this device and the server?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              setDeletingId(submissionId);
              await deleteSubmissionLocallyAndRemote(submissionId);
              await loadSubmissions();
              Alert.alert('Deleted', 'Submission and server artifacts permanently deleted.');
            } catch (err: any) {
              Alert.alert('Delete Failed', err.message || 'Could not delete submission.');
            } finally {
              setDeletingId(null);
            }
          },
        },
      ]
    );
  };

  /**
   * Evaluates the progress state of an individual document extraction pipeline.
   * Checks both isolated document containers (Task 45) and top-level fields.
   */
  const evaluateServiceStage = (
    submissionStatus: SubmissionStatus,
    extractedData: any,
    imagePath: string | null | undefined,
    subDocumentKey?: string,
    fieldKeys: string[] = []
  ): StageStatus => {
    if (!imagePath) {
      return 'NOT_ATTACHED';
    }

    if (!extractedData) {
      return submissionStatus === 'PROCESSING' ? 'PROCESSING' : 'PENDING';
    }

    // Task 45: Check isolated document bucket first
    if (subDocumentKey && extractedData.documents && extractedData.documents[subDocumentKey]) {
      const bucket = extractedData.documents[subDocumentKey];
      const hasExtractedBucketValue = fieldKeys.some((k) => {
        const field = bucket[k];
        if (!field) return false;
        if (typeof field === 'object' && 'value' in field) {
          return field.value !== null && field.value !== undefined && String(field.value).trim() !== '';
        }
        return String(field).trim() !== '';
      });
      if (hasExtractedBucketValue) {
        return 'COMPLETED';
      }
    }

    // Top-level fallback
    const hasExtractedValue = fieldKeys.some((k) => {
      const field = extractedData[k];
      if (!field) return false;
      if (typeof field === 'object' && 'value' in field) {
        return field.value !== null && field.value !== undefined && String(field.value).trim() !== '';
      }
      return String(field).trim() !== '';
    });

    if (hasExtractedValue) {
      return 'COMPLETED';
    }

    return submissionStatus === 'PROCESSING' ? 'PROCESSING' : 'PENDING';
  };

  /**
   * Helper rendering an individual stage pill badge.
   */
  const renderStagePill = (label: string, stageStatus: StageStatus) => {
    let pillBg = colors.surfaceSubtle;
    let textColor = colors.textMuted;
    let statusText = 'Pending ⏳';

    if (stageStatus === 'COMPLETED') {
      pillBg = colors.statusReady; // Emerald green
      textColor = '#FFFFFF';
      statusText = 'Done ✓';
    } else if (stageStatus === 'PROCESSING') {
      pillBg = colors.statusProcess; // Blue
      textColor = '#FFFFFF';
      statusText = 'Running ⏳';
    } else if (stageStatus === 'NOT_ATTACHED') {
      pillBg = colors.surfaceSubtle;
      textColor = colors.textMuted;
      statusText = 'None';
    }

    return (
      <View style={[styles.stagePill, { backgroundColor: pillBg, borderColor: colors.border }]} key={label}>
        <Text style={[styles.stagePillLabel, { color: textColor }]}>
          {label}: <Text style={{ fontWeight: '700' }}>{statusText}</Text>
        </Text>
      </View>
    );
  };

  /**
   * Maps overall submission status to a human badge.
   */
  const getStatusBadgeStyle = (status: SubmissionStatus) => {
    switch (status) {
      case 'UPLOAD_PENDING':
        return { backgroundColor: '#F59E0B', label: 'Upload Pending' };
      case 'PROCESSING':
        return { backgroundColor: colors.statusProcess, label: 'Processing' };
      case 'PENDING_REVIEW':
        return { backgroundColor: colors.statusReady, label: 'Ready for Review' };
      case 'SUBMITTED':
        return { backgroundColor: '#10B981', label: 'Verified' };
      case 'FAILED':
        return { backgroundColor: '#EF4444', label: 'Failed' };
      default:
        return { backgroundColor: '#64748B', label: status };
    }
  };

  /**
   * Formats ISO timestamp into a readable date string.
   */
  const formatDate = (isoString?: string) => {
    if (!isoString) return '';
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  /**
   * Renders each individual submission card with per-guest granular status strips.
   */
  const renderSubmissionItem = ({ item }: { item: SubmissionWithGuests }) => {
    const badge = getStatusBadgeStyle(item.status);
    const isReadyForReview = item.status === 'PENDING_REVIEW' || item.status === 'SUBMITTED';
    const isUploadPending = item.status === 'UPLOAD_PENDING';
    const isProcessing = item.status === 'PROCESSING';
    const isThisCardActive = retryingId === item.id;
    const isThisCardDeleting = deletingId === item.id;
    const guestList = Array.isArray(item.guests) ? item.guests : [];

    return (
      <View
        style={[
          styles.submissionCard,
          {
            backgroundColor: colors.surface,
            borderColor: colors.border,
          },
        ]}
      >
        {/* Card Header & Metadata */}
        <TouchableOpacity activeOpacity={0.7} onPress={() => onOpenReview(item.id)}>
          <View style={styles.cardHeaderRow}>
            <Text style={[styles.referenceText, { color: colors.textPrimary }]} numberOfLines={1}>
              {item.reference || 'Homestay Guest Capture'}
            </Text>
            <View style={[styles.statusBadge, { backgroundColor: badge.backgroundColor }]}>
              <Text style={styles.statusBadgeText}>{badge.label}</Text>
            </View>
          </View>

          <View style={styles.cardMetaRow}>
            <Text style={[styles.metaLabel, { color: colors.textMuted }]}>
              ID: <Text style={{ color: colors.textPrimary }}>{item.id.slice(0, 16)}...</Text>
            </Text>
            <Text style={[styles.metaLabel, { color: colors.textMuted }]}>
              {item.guest_count} Guest{item.guest_count > 1 ? 's' : ''}
            </Text>
          </View>

          <View style={styles.dateRow}>
            <Text style={[styles.dateText, { color: colors.textMuted }]}>
              {formatDate(item.created_at)}
            </Text>
          </View>
        </TouchableOpacity>

        {/* Granular Per-Guest Service Pipeline Badges (Task 42 & 45) */}
        <View style={[styles.guestListContainer, { borderTopColor: colors.border }]}>
          {guestList.map((guest, idx) => {
            let extractedData: any = null;
            if (guest.extracted_data_json) {
              try {
                extractedData = JSON.parse(guest.extracted_data_json);
              } catch {
                extractedData = null;
              }
            }

            const passportStatus = evaluateServiceStage(
              item.status,
              extractedData,
              guest.passport_bio_path,
              'passport_bio',
              ['surname', 'given_names', 'passport_number', 'nationality']
            );

            // Task 42: Dual Visa Status
            const visaDocStatus = evaluateServiceStage(
              item.status,
              extractedData,
              guest.visa_document_path,
              'visa_document',
              ['visa_number', 'visa_type', 'visa_issue_date', 'visa_expiry_date']
            );

            const visaStampStatus = evaluateServiceStage(
              item.status,
              extractedData,
              guest.visa_stamp_path,
              'visa_stamp',
              ['visa_number', 'visa_type', 'visa_issue_date', 'visa_expiry_date']
            );

            const stampStatus = evaluateServiceStage(
              item.status,
              extractedData,
              guest.entry_stamp_path,
              'entry_stamp',
              ['arrival_date_india', 'arrival_port_india']
            );

            const formCStatus = evaluateServiceStage(
              item.status,
              extractedData,
              guest.form_c_path,
              'welcome_form',
              ['permanent_address', 'contact_email', 'contact_phone', 'arrived_from', 'proceeding_to']
            );

            return (
              <View key={guest.id || `guest_${idx}`} style={styles.guestStatusSection}>
                <Text style={[styles.guestHeaderTitle, { color: colors.textPrimary }]}>
                  👤 Guest {idx + 1} Pipeline Services:
                </Text>
                <View style={styles.stagePillsGrid}>
                  {renderStagePill('1. Passport Bio', passportStatus)}

                  {/* Render Visa Doc pill if attached */}
                  {guest.visa_document_path && renderStagePill('2A. Visa Doc', visaDocStatus)}

                  {/* Render Visa Stamp pill if attached */}
                  {guest.visa_stamp_path && renderStagePill('2B. Visa Stamp', visaStampStatus)}

                  {/* If neither visa is attached, render single fallback pill */}
                  {!guest.visa_document_path && !guest.visa_stamp_path && renderStagePill('2. Visa', 'NOT_ATTACHED')}

                  {renderStagePill('3. Entry Stamp', stampStatus)}
                  {renderStagePill('4. Form-C Report', formCStatus)}
                </View>
              </View>
            );
          })}
        </View>

        {/* Submission-Level Action Footer (Task 43 & 44) */}
        <View style={[styles.cardFooterActions, { borderTopColor: colors.border }]}>
          {isThisCardActive ? (
            <View style={styles.centeredRow}>
              <ActivityIndicator size="small" color={colors.primaryBrand} />
              <Text style={[styles.processingText, { color: colors.primaryBrand }]}>
                {' '}Submitting bundle...
              </Text>
            </View>
          ) : isUploadPending ? (
            <TouchableOpacity onPress={() => handleTriggerReExtract(item)} style={styles.singleActionButton}>
              <Text style={[styles.actionPromptText, { color: colors.primaryBrand }]}>
                Tap to Send Submission for Extraction ⟳
              </Text>
            </TouchableOpacity>
          ) : isProcessing ? (
            <View style={styles.centeredRow}>
              <ActivityIndicator size="small" color={colors.primaryBrand} />
              <Text style={[styles.processingText, { color: colors.primaryBrand }]}>
                {' '}AI extraction in progress...
              </Text>
            </View>
          ) : isReadyForReview ? (
            <View style={styles.splitActionRow}>
              {/* Submission-level Re-run */}
              <TouchableOpacity
                onPress={() => handleTriggerReExtract(item)}
                style={[styles.smallButton, { backgroundColor: colors.surfaceSubtle, borderColor: colors.border }]}
              >
                <Text style={[styles.smallButtonText, { color: colors.textMuted }]}>⟳ Re-run</Text>
              </TouchableOpacity>

              {/* Review & Edit */}
              <TouchableOpacity
                onPress={() => onOpenReview(item.id)}
                style={[styles.smallButton, { backgroundColor: colors.surfaceSubtle, borderColor: colors.border, marginLeft: 8 }]}
              >
                <Text style={[styles.smallButtonText, { color: colors.textPrimary }]}>✏️ Review</Text>
              </TouchableOpacity>

              {/* Task 44: Delete Submission */}
              <TouchableOpacity
                onPress={() => handleDeleteSubmission(item.id)}
                disabled={isThisCardDeleting}
                style={[styles.smallButton, { backgroundColor: '#FEE2E2', borderColor: '#FCA5A5', marginLeft: 8 }]}
              >
                {isThisCardDeleting ? (
                  <ActivityIndicator size="small" color="#EF4444" />
                ) : (
                  <Text style={[styles.smallButtonText, { color: '#B91C1C' }]}>🗑 Delete</Text>
                )}
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.splitActionRow}>
              <Text style={[styles.actionPromptText, { color: colors.textMuted }]}>
                {item.status}
              </Text>
              <TouchableOpacity
                onPress={() => handleDeleteSubmission(item.id)}
                disabled={isThisCardDeleting}
                style={[styles.smallButton, { backgroundColor: '#FEE2E2', borderColor: '#FCA5A5', marginLeft: 8 }]}
              >
                <Text style={[styles.smallButtonText, { color: '#B91C1C' }]}>🗑 Delete</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Top Navigation & App Bar */}
      <View
        style={[
          styles.topBar,
          { backgroundColor: colors.surface, borderBottomColor: colors.border },
        ]}
      >
        <Text style={[styles.appTitle, { color: colors.primaryBrand }]}>
          Homestay Document Capture
        </Text>
        <View style={styles.topBarActions}>
          <TouchableOpacity
            onPress={handleOpenCredentialsModal}
            style={[styles.iconButton, { backgroundColor: colors.surfaceSubtle }]}
          >
            <Text style={styles.iconButtonText}>🔑</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={toggleTheme}
            style={[styles.iconButton, { backgroundColor: colors.surfaceSubtle, marginLeft: 8 }]}
          >
            <Text style={styles.iconButtonText}>{isDark ? '☀️' : '🌙'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Submissions List */}
      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={colors.primaryBrand} />
        </View>
      ) : (
        <FlatList
          data={submissions}
          keyExtractor={(item) => item.id}
          renderItem={renderSubmissionItem}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              colors={[colors.primaryBrand]}
              tintColor={colors.primaryBrand}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>No Submissions Yet</Text>
              <Text style={[styles.emptySubtitle, { color: colors.textMuted }]}>
                Tap the button below to capture identity documents and arrival slips for a new guest check-in.
              </Text>
            </View>
          }
        />
      )}

      {/* Floating Bottom Button: Capture New Guest */}
      <View style={[styles.bottomBarContainer, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
        <TouchableOpacity
          style={[styles.primaryActionButton, { backgroundColor: colors.primaryBrand }]}
          onPress={onStartNewCapture}
        >
          <Text style={styles.primaryActionText}>+ Capture New Guest Check-In</Text>
        </TouchableOpacity>
      </View>

      {/* Credentials Modal */}
      <Modal visible={isCredsModalVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalDialog, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>Form-C Portal Login</Text>
            <Text style={[styles.modalSubtitle, { color: colors.textMuted }]}>
              Stored in Android Keystore for secure verification.
            </Text>

            <View style={styles.modalFieldGroup}>
              <Text style={[styles.modalLabel, { color: colors.textMuted }]}>User ID</Text>
              <TextInput
                style={[
                  styles.modalInput,
                  {
                    color: colors.textPrimary,
                    borderColor: colors.border,
                    backgroundColor: colors.surfaceSubtle,
                  },
                ]}
                value={portalUserId}
                onChangeText={setPortalUserId}
                autoCapitalize="none"
                placeholder="Enter Portal User ID"
                placeholderTextColor={colors.textMuted}
              />
            </View>

            <View style={styles.modalFieldGroup}>
              <Text style={[styles.modalLabel, { color: colors.textMuted }]}>Password</Text>
              <TextInput
                style={[
                  styles.modalInput,
                  {
                    color: colors.textPrimary,
                    borderColor: colors.border,
                    backgroundColor: colors.surfaceSubtle,
                  },
                ]}
                value={portalPassword}
                onChangeText={setPortalPassword}
                secureTextEntry
                placeholder="Enter Portal Password"
                placeholderTextColor={colors.textMuted}
              />
            </View>

            <View style={styles.modalActionsRow}>
              <TouchableOpacity
                onPress={handleClearCredentials}
                style={[styles.modalActionButton, { backgroundColor: '#FEE2E2' }]}
              >
                <Text style={[styles.modalActionText, { color: '#EF4444' }]}>Clear</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => setIsCredsModalVisible(false)}
                style={[styles.modalActionButton, { backgroundColor: colors.surfaceSubtle }]}
              >
                <Text style={[styles.modalActionText, { color: colors.textPrimary }]}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleSaveCredentials}
                disabled={isSavingCreds}
                style={[styles.modalActionButton, { backgroundColor: colors.primaryBrand }]}
              >
                {isSavingCreds ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={[styles.modalActionText, { color: '#FFFFFF' }]}>Save</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topBar: {
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  appTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  topBarActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonText: {
    fontSize: 18,
  },
  listContent: {
    padding: 16,
    paddingBottom: 90,
  },
  submissionCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 12,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  referenceText: {
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
    marginRight: 8,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statusBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  cardMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  metaLabel: {
    fontSize: 13,
  },
  dateRow: {
    marginBottom: 8,
  },
  dateText: {
    fontSize: 12,
  },
  guestListContainer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    marginBottom: 8,
  },
  guestStatusSection: {
    marginBottom: 6,
  },
  guestHeaderTitle: {
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
  },
  stagePillsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  stagePill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  stagePillLabel: {
    fontSize: 11,
  },
  cardFooterActions: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  singleActionButton: {
    paddingVertical: 4,
  },
  actionPromptText: {
    fontSize: 13,
    fontWeight: '600',
  },
  splitActionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  centeredRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  processingText: {
    fontSize: 13,
    fontWeight: '500',
  },
  smallButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  smallButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  emptyContainer: {
    paddingTop: 60,
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  bottomBarContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 16,
    borderTopWidth: 1,
  },
  primaryActionButton: {
    height: 50,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryActionText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalDialog: {
    width: '100%',
    borderRadius: 14,
    borderWidth: 1,
    padding: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  modalSubtitle: {
    fontSize: 13,
    marginBottom: 16,
  },
  modalFieldGroup: {
    marginBottom: 12,
  },
  modalLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },
  modalInput: {
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  modalActionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16,
  },
  modalActionButton: {
    flex: 0.31,
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalActionText: {
    fontSize: 14,
    fontWeight: '600',
  },
});

export default DashboardScreen;