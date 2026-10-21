/**
 * DashboardScreen.tsx
 * Primary operational dashboard for Homestay Document Capture & Processing.
 * 
 * Responsibilities:
 * - Displays active guest document capture batches and statuses.
 * - Manages submission re-extraction triggers with automatic residual cache invalidation.
 * - Handles extraction failure states gracefully, preventing cards from getting stuck in PROCESSING.
 * - Renders granular per-document service pipeline status pills (Passport, Visa, Stamp, Form-C).
 * - Interfaces with secure storage for encrypted Form-C portal credentials.
 */

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

// App theme context and dark/light mode tokens
import { useAppTheme } from '../theme/ThemeContext';

// Local SQLite database providers and models
import {
  getAllSubmissions,
  openDatabase,
  updateSubmissionStatus,
  SubmissionRecord,
  GuestDocumentRecord,
  SubmissionStatus,
} from '../db/database';

// Asynchronous background synchronization services
import { runFullSync, pollJobUntilComplete } from '../services/syncManager';

// HTTP boundary client for remote FastAPI document ingestion
import { submitGuestDocuments } from '../services/apiService';

// Secure credentials store for Form-C portal automation
import {
  getPortalCredentials,
  savePortalCredentials,
  clearPortalCredentials,
} from '../services/credentialService';

interface DashboardScreenProps {
  onStartNewCapture: () => void;
  onOpenReview: (submissionId: string) => void;
  onOpenPortal: (submissionId: string) => void;
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
  onOpenPortal,
}) => {
  const { colors, isDark, toggleTheme } = useAppTheme();

  // Screen queue and processing states
  const [submissions, setSubmissions] = useState<SubmissionWithGuests[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);

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
   * Clears stale extraction cache and resets to UPLOAD_PENDING if an error occurs.
   *
   * @param item - The submission record to re-extract
   */
  const handleTriggerReExtract = async (item: SubmissionWithGuests) => {
    if (!item || !item.id) {
      Alert.alert('Error', 'Invalid submission record ID.');
      return;
    }

    const safeSubmissionId = String(item.id).trim();
    const guestList = Array.isArray(item.guests) ? item.guests : [];

    if (guestList.length === 0) {
      Alert.alert('Error', 'No guest document records found for this submission.');
      return;
    }

    const guestDoc = guestList[0];

    try {
      setRetryingId(item.id);
      console.log(`[Dashboard] Starting submission-level re-extraction for ID: ${item.id}`);

      const db = await openDatabase();

      // Clear stale extraction JSON so stage badges reset
      console.log(`[Dashboard] Invalidating stale extraction cache for: ${safeSubmissionId}`);
      await db.runAsync(
        'UPDATE guest_documents SET extracted_data_json = NULL WHERE submission_id = ?;',
        [safeSubmissionId]
      );

      // Transition to PROCESSING
      await updateSubmissionStatus(safeSubmissionId, 'PROCESSING');
      await loadSubmissions();

      // Dispatch documents to backend FastAPI endpoint
      const response = await submitGuestDocuments(
        guestDoc.passport_bio_path,
        guestDoc.visa_stamp_path ?? undefined,
        guestDoc.entry_stamp_path ?? undefined,
        guestDoc.form_c_path ?? undefined,
        item.reference ?? undefined
      );

      console.log(`[Dashboard] Re-upload succeeded with job_id: ${response.job_id}`);

      // Save new job_id in SQLite
      await updateSubmissionStatus(safeSubmissionId, 'PROCESSING', response.job_id);
      await loadSubmissions();

      // Poll in background
      pollJobUntilComplete(safeSubmissionId, response.job_id)
        .then(() => loadSubmissions())
        .catch((err) => {
          console.warn('[Dashboard] Background polling error:', err);
          loadSubmissions();
        });

      Alert.alert(
        'Processing Initiated',
        `Job dispatched to server with ID: ${response.job_id.slice(0, 8)}... Stage labels will update automatically.`
      );
    } catch (error: any) {
      console.error(`[Dashboard] Re-extraction request failed for ${item.id}:`, error);

      // Reset to UPLOAD_PENDING so the card does not remain stuck on "AI extraction in progress"
      try {
        await updateSubmissionStatus(safeSubmissionId, 'UPLOAD_PENDING');
        await loadSubmissions();
      } catch (dbErr) {
        console.warn('[Dashboard] Failed to reset status after error:', dbErr);
      }

      Alert.alert(
        'Submission Failed',
        `Could not reach extraction service: ${error.message || error}`
      );
    } finally {
      setRetryingId(null);
    }
  };

  useEffect(() => {
    loadSubmissions();
  }, [loadSubmissions]);

  const getStatusBadgeStyle = (status: SubmissionStatus) => {
    switch (status) {
      case 'UPLOAD_PENDING':
        return { backgroundColor: colors.statusPending, label: 'Upload Pending' };
      case 'PROCESSING':
        return { backgroundColor: colors.statusProcess, label: 'Processing' };
      case 'PENDING_REVIEW':
        return { backgroundColor: colors.statusReady, label: 'Ready for Review' };
      case 'REVIEWED':
        return { backgroundColor: colors.statusDone, label: 'Reviewed' };
      default:
        return { backgroundColor: colors.textMuted, label: status };
    }
  };

  const evaluateServiceStage = (
    submissionStatus: SubmissionStatus,
    extractedData: any,
    documentPath: string | null | undefined,
    fieldKeys: string[]
  ): StageStatus => {
    if (!documentPath) {
      return 'NOT_ATTACHED';
    }

    if (extractedData && typeof extractedData === 'object') {
      const hasExtractedField = fieldKeys.some((k) => {
        const val = extractedData[k];
        if (!val) return false;
        if (typeof val === 'object' && 'value' in val) {
          return val.value !== null && val.value !== undefined && String(val.value).trim().length > 0;
        }
        return String(val).trim().length > 0;
      });

      if (hasExtractedField) {
        return 'COMPLETED';
      }
    }

    if (submissionStatus === 'PROCESSING') {
      return 'PROCESSING';
    }

    if (submissionStatus === 'PENDING_REVIEW' || submissionStatus === 'REVIEWED') {
      return 'COMPLETED';
    }

    return 'PENDING';
  };

  const formatDate = (isoString: string): string => {
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  const handleCardPress = (item: SubmissionWithGuests) => {
    if (item.status === 'REVIEWED' || item.status === 'PENDING_REVIEW') {
      onOpenReview(item.id);
    } else if (item.status === 'UPLOAD_PENDING') {
      handleTriggerReExtract(item);
    }
  };

  const renderStagePill = (label: string, stageStatus: StageStatus) => {
    let pillBg = colors.surfaceSubtle;
    let textColor = colors.textMuted;
    let statusText = 'Pending';

    if (stageStatus === 'COMPLETED') {
      pillBg = colors.statusReady;
      textColor = '#FFFFFF';
      statusText = 'Done ✓';
    } else if (stageStatus === 'PROCESSING') {
      pillBg = colors.statusProcess;
      textColor = '#FFFFFF';
      statusText = 'Running ⏳';
    } else if (stageStatus === 'NOT_ATTACHED') {
      pillBg = colors.surfaceSubtle;
      textColor = colors.textMuted;
      statusText = 'None';
    }

    return (
      <View style={[styles.stagePill, { backgroundColor: pillBg, borderColor: colors.border }]}>
        <Text style={[styles.stagePillLabel, { color: textColor }]}>
          {label}: <Text style={{ fontWeight: '700' }}>{statusText}</Text>
        </Text>
      </View>
    );
  };

  const renderSubmissionItem = ({ item }: { item: SubmissionWithGuests }) => {
    const badge = getStatusBadgeStyle(item.status);
    const isReadyForReview = item.status === 'PENDING_REVIEW';
    const isReviewed = item.status === 'REVIEWED';
    const isUploadPending = item.status === 'UPLOAD_PENDING';
    const isProcessing = item.status === 'PROCESSING';
    const isThisCardActive = retryingId === item.id;
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
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => handleCardPress(item)}
        >
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

        {/* Per-Guest Stage Badges */}
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
              ['surname', 'given_names', 'passport_number', 'nationality']
            );
            const visaStatus = evaluateServiceStage(
              item.status,
              extractedData,
              guest.visa_stamp_path,
              ['visa_number', 'visa_type', 'visa_issue_date', 'visa_expiry_date']
            );
            const stampStatus = evaluateServiceStage(
              item.status,
              extractedData,
              guest.entry_stamp_path,
              ['arrival_date_india', 'arrival_port_india']
            );
            const formCStatus = evaluateServiceStage(
              item.status,
              extractedData,
              guest.form_c_path,
              ['permanent_address', 'contact_email', 'contact_phone', 'arrived_from', 'proceeding_to']
            );

            return (
              <View key={guest.id || `guest_${idx}`} style={styles.guestStatusSection}>
                <Text style={[styles.guestHeaderTitle, { color: colors.textPrimary }]}>
                  👤 Guest {idx + 1} Pipeline Services:
                </Text>
                <View style={styles.stagePillsGrid}>
                  {renderStagePill('1. Passport / MRZ', passportStatus)}
                  {renderStagePill('2. Visa / OCI', visaStatus)}
                  {renderStagePill('3. Entry Stamp', stampStatus)}
                  {renderStagePill('4. Form-C Report', formCStatus)}
                </View>
              </View>
            );
          })}
        </View>

        {/* Action Buttons */}
        <View style={[styles.cardFooterActions, { borderTopColor: colors.border }]}>
          {isThisCardActive ? (
            <View style={styles.centeredRow}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={[styles.processingText, { color: colors.accent }]}> Submitting bundle...</Text>
            </View>
          ) : isUploadPending ? (
            <TouchableOpacity onPress={() => handleTriggerReExtract(item)} style={styles.singleActionButton}>
              <Text style={[styles.actionPromptText, { color: colors.accent }]}>
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
              <TouchableOpacity
                onPress={() => handleTriggerReExtract(item)}
                style={[styles.smallButton, { backgroundColor: colors.surfaceSubtle, borderColor: colors.border }]}
              >
                <Text style={[styles.smallButtonText, { color: colors.textMuted }]}>⟳ Re-run All</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => onOpenReview(item.id)}
                style={[styles.smallButton, { backgroundColor: colors.statusReady, marginLeft: 8 }]}
              >
                <Text style={[styles.smallButtonText, { color: '#FFFFFF', fontWeight: '700' }]}>
                  Verify Details →
                </Text>
              </TouchableOpacity>
            </View>
          ) : isReviewed ? (
            <View style={styles.splitActionRow}>
              <TouchableOpacity
                onPress={() => handleTriggerReExtract(item)}
                style={[styles.smallButton, { backgroundColor: colors.surfaceSubtle, borderColor: colors.border }]}
              >
                <Text style={[styles.smallButtonText, { color: colors.textMuted }]}>⟳ Re-run All</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => onOpenReview(item.id)}
                style={[styles.smallButton, { backgroundColor: colors.surfaceSubtle, borderColor: colors.border, marginLeft: 8 }]}
              >
                <Text style={[styles.smallButtonText, { color: colors.textPrimary }]}>✏️ Edit</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => onOpenPortal(item.id)}
                style={[styles.smallButton, { backgroundColor: colors.primaryBrand, marginLeft: 8 }]}
              >
                <Text style={[styles.smallButtonText, { color: '#FFFFFF', fontWeight: '700' }]}>
                  🚀 Portal
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
            <Text style={[styles.actionPromptText, { color: colors.textMuted }]}>
              {item.status}
            </Text>
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
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
              <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>No captures yet</Text>
              <Text style={[styles.emptySubtitle, { color: colors.textMuted }]}>
                Tap the button below to capture the guest documents.
              </Text>
            </View>
          }
        />
      )}

      <View
        style={[
          styles.bottomBarContainer,
          { backgroundColor: colors.surface, borderTopColor: colors.border },
        ]}
      >
        <TouchableOpacity
          onPress={onStartNewCapture}
          style={[styles.primaryActionButton, { backgroundColor: colors.primaryBrand }]}
        >
          <Text style={styles.primaryActionText}>+ New Guest Capture</Text>
        </TouchableOpacity>
      </View>

      <Modal
        visible={isCredsModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsCredsModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View
            style={[
              styles.modalDialog,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>
              Form-C Portal Credentials
            </Text>
            <Text style={[styles.modalSubtitle, { color: colors.textMuted }]}>
              Stored encrypted on device using Android Keystore.
            </Text>

            <View style={styles.modalFieldGroup}>
              <Text style={[styles.modalLabel, { color: colors.textPrimary }]}>Portal User ID</Text>
              <TextInput
                style={[
                  styles.modalInput,
                  {
                    backgroundColor: colors.surfaceSubtle,
                    color: colors.textPrimary,
                    borderColor: colors.border,
                  },
                ]}
                placeholder="e.g. KER_KOC_00123"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                value={portalUserId}
                onChangeText={setPortalUserId}
              />
            </View>

            <View style={styles.modalFieldGroup}>
              <Text style={[styles.modalLabel, { color: colors.textPrimary }]}>Portal Password</Text>
              <TextInput
                style={[
                  styles.modalInput,
                  {
                    backgroundColor: colors.surfaceSubtle,
                    color: colors.textPrimary,
                    borderColor: colors.border,
                  },
                ]}
                placeholder="Enter password"
                placeholderTextColor={colors.textMuted}
                secureTextEntry={true}
                autoCapitalize="none"
                value={portalPassword}
                onChangeText={setPortalPassword}
              />
            </View>

            <View style={styles.modalActionsRow}>
              <TouchableOpacity
                onPress={handleClearCredentials}
                style={[styles.modalActionButton, { backgroundColor: colors.statusPending }]}
              >
                <Text style={styles.modalActionText}>Clear</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => setIsCredsModalVisible(false)}
                style={[
                  styles.modalActionButton,
                  { backgroundColor: colors.surfaceSubtle, borderColor: colors.border, borderWidth: 1 },
                ]}
              >
                <Text style={[styles.modalActionText, { color: colors.textPrimary }]}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                disabled={isSavingCreds}
                onPress={handleSaveCredentials}
                style={[styles.modalActionButton, { backgroundColor: colors.primaryBrand }]}
              >
                {isSavingCreds ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.modalActionText}>Save</Text>
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
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
});

export default DashboardScreen;